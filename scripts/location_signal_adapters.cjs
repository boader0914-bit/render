"use strict";

const {
  buildLeadTimeObservation,
  buildObservation,
  buildRegionalRevenueTargetFrame,
  deepFreeze,
  fingerprintRequest
} = require("./location_insight_contract.cjs");

const ADAPTER_SCHEMA_VERSIONS = deepFreeze({
  naverDataLab: "location-signal.naver-datalab.v1",
  naverSearchAd: "location-signal.naver-searchad.v1",
  lodgingInventory: "location-signal.lodging-inventory.v1",
  regionalRevenue: "location-signal.regional-revenue.v1"
});

class SignalAdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SignalAdapterError";
    this.code = code;
    this.details = deepFreeze({ ...details });
  }
}

function boundedText(value, max = 320) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function temporalText(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "";
  return boundedText(value, 48);
}

function parsedTime(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : null;
}

function requireTime(value, field) {
  const normalized = temporalText(value);
  if (parsedTime(normalized) === null) {
    throw new SignalAdapterError("INVALID_TIME", `${field} must be an ISO date or timestamp`, { field });
  }
  return normalized;
}

function dateText(value) {
  const raw = temporalText(value);
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{6}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-01`;
  if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const time = parsedTime(raw);
  return time === null ? "" : new Date(time).toISOString().slice(0, 10);
}

function addUtcDays(date, days) {
  const time = parsedTime(`${date}T00:00:00.000Z`);
  return time === null ? "" : new Date(time + days * 86400000).toISOString().slice(0, 10);
}

function monthEnd(date) {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  if (!match) return "";
  return new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).toISOString().slice(0, 10);
}

function periodRange(period, timeUnit = "date") {
  const from = dateText(period);
  if (!from || parsedTime(from) === null) {
    throw new SignalAdapterError("INVALID_PERIOD", "period must identify a calendar date or month", { period });
  }
  const unit = boundedText(timeUnit || "date", 16).toLowerCase();
  const to = unit === "month" ? monthEnd(from) : unit === "week" ? addUtcDays(from, 6) : from;
  return { key: from, from, to, timeUnit: unit };
}

function monthlyRange(input = {}) {
  const explicitFrom = dateText(input.period?.from || input.observedFrom);
  const explicitTo = dateText(input.period?.to || input.observedTo);
  if (explicitFrom && explicitTo) return { from: explicitFrom, to: explicitTo };
  const month = boundedText(input.yearMonth || input.period || "", 16).replace(/[^0-9]/g, "").slice(0, 6);
  if (!/^\d{6}$/.test(month) || Number(month.slice(4, 6)) < 1 || Number(month.slice(4, 6)) > 12) {
    throw new SignalAdapterError("INVALID_PERIOD", "yearMonth or period.from/period.to is required");
  }
  const from = `${month.slice(0, 4)}-${month.slice(4, 6)}-01`;
  return { from, to: monthEnd(from) };
}

function normalizedKeyword(value) {
  return boundedText(value, 160).toLowerCase().replace(/\s+/g, "");
}

function uniqueStrings(values = []) {
  const output = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = boundedText(value, 160);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeInteger(value) {
  const number = finiteNumber(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

function geoFrom(input = {}) {
  const geo = input.geo && typeof input.geo === "object" ? input.geo : {};
  return {
    codeSystem: boundedText(geo.codeSystem || input.geoCodeSystem || "REGION_KEY", 80),
    code: boundedText(geo.code || input.geoCode || input.regionKey, 160),
    level: boundedText(geo.level || input.geoLevel || "sigungu", 40).toLowerCase(),
    name: boundedText(geo.name || input.geoName, 160)
  };
}

function availabilityContext(input = {}, availableAtOverride = "") {
  const availableAt = requireTime(availableAtOverride || input.availableAt || input.fetchedAt, "availableAt");
  const featureAsOf = requireTime(input.featureAsOf, "featureAsOf");
  if (parsedTime(availableAt) > parsedTime(featureAsOf)) {
    throw new SignalAdapterError(
      "FEATURE_LEAKAGE",
      "A feature cannot use a signal that was unavailable at featureAsOf",
      { availableAt, featureAsOf }
    );
  }
  return { availableAt, featureAsOf, modelRole: "feature" };
}

function assertObservedByFeatureAsOf(observedTo, featureAsOf) {
  if (parsedTime(observedTo) > parsedTime(featureAsOf)) {
    throw new SignalAdapterError(
      "FEATURE_PERIOD_LEAKAGE",
      "A feature period cannot extend beyond featureAsOf",
      { observedTo, featureAsOf }
    );
  }
}

function confidenceFor(status, penaltyCodes = []) {
  const score = {
    ready: 92,
    zero: 92,
    partial: 60,
    stale: 48,
    conflict: 20,
    missing: null
  }[status];
  const grade = { ready: "A", zero: "A", partial: "C", stale: "C", conflict: "D", missing: "U" }[status] || "U";
  return {
    grade,
    score,
    penalties: uniqueStrings(penaltyCodes).map((code) => ({ code }))
  };
}

function summarizeStatuses(statuses = []) {
  if (!statuses.length || statuses.every((status) => status === "missing")) return "missing";
  if (statuses.includes("conflict")) return "conflict";
  if (statuses.includes("stale")) return "stale";
  if (statuses.includes("partial") || statuses.includes("missing")) return "partial";
  if (statuses.every((status) => status === "zero")) return "zero";
  return "ready";
}

function rawNaverSeries(input = {}) {
  if (input.series && typeof input.series === "object") return input.series;
  if (input.result && typeof input.result === "object") return input.result;
  const candidates = input.results || input.raw?.results || [];
  if (!Array.isArray(candidates) || !candidates.length) return {};
  const requested = normalizedKeyword(input.groupName || input.title);
  return candidates.find((series) => normalizedKeyword(series?.title) === requested) || candidates[0] || {};
}

function relativeIndex(value) {
  if (value === null || value === undefined || value === "") return { kind: "missing", value: null };
  const parsed = finiteNumber(String(value).replace(/,/g, ""));
  if (parsed === null) return { kind: "missing", value: null };
  if (parsed < 0 || parsed > 100) return { kind: "conflict", value: parsed };
  return { kind: "exact", value: parsed };
}

function adaptNaverDataLabSeries(input = {}) {
  const series = rawNaverSeries(input);
  const timeUnit = boundedText(input.timeUnit || series.timeUnit || "date", 16).toLowerCase();
  const fetchedAt = requireTime(input.fetchedAt, "fetchedAt");
  const rootAvailability = availabilityContext(input);
  const rawPoints = Array.isArray(series.data) ? series.data : Array.isArray(input.data) ? input.data : [];
  const observedByPeriod = new Map();
  for (const point of rawPoints) {
    let range;
    try {
      range = periodRange(point?.period, timeUnit);
    } catch {
      continue;
    }
    const list = observedByPeriod.get(range.key) || [];
    list.push({ ...point, range });
    observedByPeriod.set(range.key, list);
  }

  const expectedInput = Array.isArray(input.expectedPeriods) && input.expectedPeriods.length
    ? input.expectedPeriods
    : [...observedByPeriod.keys()];
  const expectedRanges = [];
  const expectedSeen = new Set();
  for (const period of expectedInput) {
    const range = periodRange(period, timeUnit);
    if (!expectedSeen.has(range.key)) {
      expectedSeen.add(range.key);
      expectedRanges.push(range);
    }
  }
  expectedRanges.sort((left, right) => left.key.localeCompare(right.key));

  const observedExpectedCount = expectedRanges.filter((range) => observedByPeriod.has(range.key)).length;
  const coverageRatio = expectedRanges.length ? observedExpectedCount / expectedRanges.length : null;
  const groupName = boundedText(series.title || input.groupName || input.title, 160);
  const keywordVariants = uniqueStrings(series.keywords || input.keywordVariants || input.keywords || []);
  const unexpectedPeriods = [...observedByPeriod.keys()].filter((key) => !expectedSeen.has(key)).sort();
  const observations = [];

  for (const range of expectedRanges) {
    assertObservedByFeatureAsOf(range.to, rootAvailability.featureAsOf);
    const points = observedByPeriod.get(range.key) || [];
    const parsedPoints = points.map((point) => relativeIndex(point.ratio ?? point.value));
    const availableAt = points[0]?.availableAt
      ? availabilityContext(input, points[0].availableAt).availableAt
      : rootAvailability.availableAt;
    const penalties = [];
    let status = "ready";
    let value = null;

    if (!points.length || !parsedPoints.length || parsedPoints.every((point) => point.kind === "missing")) {
      status = "missing";
      penalties.push("expected_period_missing");
    } else {
      const candidateValues = parsedPoints.filter((point) => point.kind !== "missing").map((point) => point.value);
      const distinctValues = [...new Set(candidateValues)];
      if (parsedPoints.some((point) => point.kind === "conflict") || distinctValues.length > 1) {
        status = "conflict";
        value = { candidates: distinctValues };
        penalties.push(parsedPoints.some((point) => point.kind === "conflict") ? "relative_index_out_of_range" : "duplicate_period_conflict");
      } else {
        value = distinctValues[0];
        status = value === 0 ? "zero" : "ready";
      }
    }

    if (status !== "missing" && status !== "conflict" && coverageRatio !== null && coverageRatio < 1) {
      status = "partial";
      penalties.push("expected_period_coverage_incomplete");
    }
    const staleAfterDays = finiteNumber(input.staleAfterDays);
    if (
      status !== "missing"
      && status !== "conflict"
      && staleAfterDays !== null
      && parsedTime(rootAvailability.featureAsOf) - parsedTime(availableAt) > staleAfterDays * 86400000
    ) {
      status = "stale";
      penalties.push("source_refresh_stale");
    }

    const observation = buildObservation({
      observationType: "relative_search_trend",
      role: "feature",
      sourceKey: "naver.trend",
      metricKey: "naver.search.relative_index",
      value,
      unit: "relative_index_0_100",
      normalization: {
        method: "naver_datalab_relative_ratio",
        version: "v1",
        parameters: {
          groupName,
          keywordVariants,
          timeUnit,
          scaleMinimum: 0,
          scaleMaximum: 100,
          isAbsoluteSearchVolume: false,
          expectedPeriodCount: expectedRanges.length,
          observedPeriodCount: observedExpectedCount
        }
      },
      geo: geoFrom(input),
      observedFrom: range.from,
      observedTo: range.to,
      sourceUpdatedAt: temporalText(input.sourceUpdatedAt || availableAt),
      fetchedAt,
      availableAt,
      featureAsOf: rootAvailability.featureAsOf,
      sample: { n: observedExpectedCount, populationN: expectedRanges.length, unit: "periods" },
      coverage: {
        numerator: observedExpectedCount,
        denominator: expectedRanges.length,
        ratio: coverageRatio,
        note: `${observedExpectedCount}/${expectedRanges.length} expected periods observed`
      },
      status,
      confidence: confidenceFor(status, penalties),
      requestFingerprint: fingerprintRequest({
        sourceKey: "naver.trend",
        groupName,
        keywordVariants,
        timeUnit,
        period: range.key,
        geo: geoFrom(input)
      }),
      ...(status === "missing" ? {} : { rawPayload: points })
    });
    observations.push(observation);
  }

  return deepFreeze({
    schemaVersion: ADAPTER_SCHEMA_VERSIONS.naverDataLab,
    signalType: "naver_relative_search_trend",
    modelRole: "feature",
    availableAt: rootAvailability.availableAt,
    featureAsOf: rootAvailability.featureAsOf,
    groupName,
    keywordVariants,
    timeUnit,
    expectedPeriods: expectedRanges.map((range) => range.key),
    observedPeriods: [...observedByPeriod.keys()].sort(),
    unexpectedPeriods,
    coverage: {
      numerator: observedExpectedCount,
      denominator: expectedRanges.length,
      ratio: coverageRatio
    },
    status: summarizeStatuses(observations.map((observation) => observation.status)),
    observations
  });
}

function parseSearchVolumeValue(value) {
  if (value === null || value === undefined || boundedText(value, 80) === "") {
    return deepFreeze({ kind: "missing", value: null, lowerBound: null, upperBound: null, pointEstimate: null, reason: "empty" });
  }
  if (typeof value === "string" && /^<\s*10$/i.test(value.trim())) {
    return deepFreeze({
      kind: "censored",
      value: { lowerBound: 0, upperBound: 9, pointEstimate: null, censoring: "less_than_10" },
      lowerBound: 0,
      upperBound: 9,
      pointEstimate: null,
      reason: "provider_censored_lt_10"
    });
  }
  const normalized = typeof value === "string" ? value.replace(/,/g, "").trim() : value;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return deepFreeze({ kind: "missing", value: null, lowerBound: null, upperBound: null, pointEstimate: null, reason: "parse_failed" });
  }
  return deepFreeze({
    kind: "exact",
    value: parsed,
    lowerBound: parsed,
    upperBound: parsed,
    pointEstimate: parsed,
    reason: ""
  });
}

function combineSearchVolumes(left, right) {
  if (left.kind === "missing" || right.kind === "missing") {
    return deepFreeze({ kind: "missing", value: null, lowerBound: null, upperBound: null, pointEstimate: null, reason: "component_missing" });
  }
  if (left.kind === "censored" || right.kind === "censored") {
    return deepFreeze({
      kind: "censored",
      value: {
        lowerBound: left.lowerBound + right.lowerBound,
        upperBound: left.upperBound + right.upperBound,
        pointEstimate: null,
        censoring: "component_range_sum"
      },
      lowerBound: left.lowerBound + right.lowerBound,
      upperBound: left.upperBound + right.upperBound,
      pointEstimate: null,
      reason: "component_censored"
    });
  }
  const total = left.value + right.value;
  return deepFreeze({ kind: "exact", value: total, lowerBound: total, upperBound: total, pointEstimate: total, reason: "" });
}

function searchAdRows(input = {}) {
  if (Array.isArray(input.rows)) return input.rows.filter((row) => row && typeof row === "object");
  if (input.row && typeof input.row === "object") return [input.row];
  if (Array.isArray(input.raw?.keywordList)) return input.raw.keywordList.filter((row) => row && typeof row === "object");
  return [];
}

function selectSearchAdRow(rows, requestedKeyword) {
  const requested = normalizedKeyword(requestedKeyword);
  const exact = rows.find((row) => normalizedKeyword(row.relKeyword ?? row.keyword) === requested);
  if (exact) return { row: exact, matchType: "exact" };
  if (rows.length) return { row: rows[0], matchType: "related" };
  return { row: null, matchType: "missing" };
}

function volumeObservationStatus(parsed, matchType) {
  if (parsed.kind === "missing") return "missing";
  if (parsed.kind === "censored" || matchType === "related") return "partial";
  return parsed.value === 0 ? "zero" : "ready";
}

function adaptNaverSearchAdRows(input = {}) {
  const rows = searchAdRows(input);
  const requestedKeyword = boundedText(input.requestedKeyword || input.keyword, 160);
  const selection = selectSearchAdRow(rows, requestedKeyword);
  const selectedKeyword = boundedText(selection.row?.relKeyword ?? selection.row?.keyword, 160);
  const keywordVariants = uniqueStrings(input.keywordVariants || rows.map((row) => row.relKeyword ?? row.keyword));
  const period = monthlyRange(input);
  const fetchedAt = requireTime(input.fetchedAt, "fetchedAt");
  const availability = availabilityContext(input);
  assertObservedByFeatureAsOf(period.to, availability.featureAsOf);

  const pc = parseSearchVolumeValue(selection.row?.monthlyPcQcCnt ?? selection.row?.monthlyPcSearchVolume);
  const mobile = parseSearchVolumeValue(selection.row?.monthlyMobileQcCnt ?? selection.row?.monthlyMobileSearchVolume);
  const total = combineSearchVolumes(pc, mobile);
  const metrics = [
    { component: "pc", metricKey: "naver.search_volume.monthly.pc", parsed: pc },
    { component: "mobile", metricKey: "naver.search_volume.monthly.mobile", parsed: mobile },
    { component: "total", metricKey: "naver.search_volume.monthly.total", parsed: total }
  ];
  const observations = metrics.map((metric) => {
    const status = volumeObservationStatus(metric.parsed, selection.matchType);
    const penalties = [];
    if (metric.parsed.kind === "missing") penalties.push(metric.parsed.reason || "search_volume_missing");
    if (metric.parsed.kind === "censored") penalties.push("provider_censored_lt_10");
    if (selection.matchType === "related") penalties.push("related_keyword_fallback");
    if (selection.matchType === "missing") penalties.push("keyword_row_missing");
    const coverageNumerator = selection.matchType === "exact" ? 1 : 0;
    return buildObservation({
      observationType: "monthly_search_volume",
      role: "feature",
      sourceKey: "naver.search_volume",
      metricKey: metric.metricKey,
      value: metric.parsed.value,
      unit: "searches_per_month",
      normalization: {
        method: metric.parsed.kind === "censored" ? "provider_censored_range" : "raw_monthly_query_count",
        version: "v1",
        parameters: {
          component: metric.component,
          requestedKeyword,
          selectedKeyword,
          keywordVariants,
          keywordMatchType: selection.matchType,
          lowerBound: metric.parsed.lowerBound,
          upperBound: metric.parsed.upperBound,
          pointEstimate: metric.parsed.pointEstimate,
          censoredValuesMustNotBeMidpointImputed: metric.parsed.kind === "censored"
        }
      },
      geo: geoFrom(input),
      observedFrom: period.from,
      observedTo: period.to,
      sourceUpdatedAt: temporalText(input.sourceUpdatedAt || availability.availableAt),
      fetchedAt,
      availableAt: availability.availableAt,
      featureAsOf: availability.featureAsOf,
      sample: { n: selection.row ? 1 : 0, populationN: rows.length, unit: "keywords" },
      coverage: {
        numerator: coverageNumerator,
        denominator: 1,
        ratio: coverageNumerator,
        note: selection.matchType === "exact" ? "exact requested keyword" : selection.matchType === "related" ? "related keyword fallback" : "keyword unavailable"
      },
      status,
      confidence: confidenceFor(status, penalties),
      requestFingerprint: fingerprintRequest({
        sourceKey: "naver.search_volume",
        requestedKeyword,
        period,
        geo: geoFrom(input)
      }),
      ...(status === "missing" ? {} : {
        rawPayload: {
          selectedKeyword,
          component: metric.component,
          rawValue: metric.component === "pc"
            ? selection.row?.monthlyPcQcCnt ?? selection.row?.monthlyPcSearchVolume
            : metric.component === "mobile"
              ? selection.row?.monthlyMobileQcCnt ?? selection.row?.monthlyMobileSearchVolume
              : {
                  pc: selection.row?.monthlyPcQcCnt ?? selection.row?.monthlyPcSearchVolume,
                  mobile: selection.row?.monthlyMobileQcCnt ?? selection.row?.monthlyMobileSearchVolume
                }
        }
      })
    });
  });

  return deepFreeze({
    schemaVersion: ADAPTER_SCHEMA_VERSIONS.naverSearchAd,
    signalType: "naver_monthly_search_volume",
    modelRole: "feature",
    availableAt: availability.availableAt,
    featureAsOf: availability.featureAsOf,
    requestedKeyword,
    selectedKeyword,
    keywordVariants,
    keywordMatchType: selection.matchType,
    period,
    status: summarizeStatuses(observations.map((observation) => observation.status)),
    observations
  });
}

function adaptNaverSearchAdRow(input = {}) {
  return adaptNaverSearchAdRows(input);
}

function parseInventoryCount(value) {
  if (value === null || value === undefined || boundedText(value, 80) === "") {
    return { kind: "missing", value: null, reason: "empty" };
  }
  const parsed = typeof value === "string" ? Number(value.replace(/,/g, "").trim()) : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return { kind: "missing", value: null, reason: "parse_failed" };
  if (parsed < 0) return { kind: "conflict", value: parsed, reason: "negative_inventory" };
  return { kind: "exact", value: parsed, reason: "" };
}

function inventoryStatus(parsed, extraConflict = "") {
  if (extraConflict || parsed.kind === "conflict") return "conflict";
  if (parsed.kind === "missing") return "missing";
  return parsed.value === 0 ? "zero" : "ready";
}

function adaptLodgingInventoryRow(input = {}) {
  const row = input.row && typeof input.row === "object" ? input.row : input;
  const propertyId = boundedText(input.propertyId || row.propertyId, 160);
  const regionKey = boundedText(input.regionKey || row.regionKey, 160);
  const runId = boundedText(input.runId || row.runId, 160);
  if (!propertyId || !regionKey || !runId) {
    throw new SignalAdapterError("INVENTORY_IDENTITY_REQUIRED", "propertyId, regionKey, and runId are required for repeated inventory observations");
  }
  const observedAt = requireTime(input.observedAt || row.observedAt || input.fetchedAt, "observedAt");
  const fetchedAt = requireTime(input.fetchedAt || observedAt, "fetchedAt");
  const availability = availabilityContext({ ...input, fetchedAt });
  const checkIn = dateText(input.checkIn || row.checkIn);
  const checkOut = dateText(input.checkOut || row.checkOut);
  if (!checkIn || !checkOut) throw new SignalAdapterError("STAY_PERIOD_REQUIRED", "checkIn and checkOut are required for inventory lead-time observations");

  const totalRaw = row.total ?? row.totalRooms ?? row.inventoryTotal;
  const availableRaw = row.available ?? row.availableRooms ?? row.inventoryAvailable;
  const total = parseInventoryCount(totalRaw);
  const available = parseInventoryCount(availableRaw);
  const exceedsTotal = total.kind === "exact" && available.kind === "exact" && available.value > total.value;
  const ratio = total.kind === "exact" && available.kind === "exact" && total.value > 0 && !exceedsTotal
    ? { kind: "exact", value: available.value / total.value, reason: "" }
    : exceedsTotal
      ? { kind: "conflict", value: { available: available.value, total: total.value }, reason: "available_exceeds_total" }
      : { kind: "missing", value: null, reason: total.value === 0 ? "zero_denominator" : "inventory_component_missing" };

  const specs = [
    { component: "total", metricKey: "lodging.inventory.total", unit: "rooms", parsed: total, extraConflict: "" },
    { component: "available", metricKey: "lodging.inventory.available", unit: "rooms", parsed: available, extraConflict: exceedsTotal ? "available_exceeds_total" : "" },
    { component: "availability_ratio", metricKey: "lodging.inventory.availability_ratio", unit: "ratio", parsed: ratio, extraConflict: exceedsTotal ? "available_exceeds_total" : "" }
  ];
  const baseSeriesKey = boundedText(input.seriesKey || row.seriesKey || `property:${propertyId}:inventory`, 160);
  const observations = specs.map((spec) => {
    const status = inventoryStatus(spec.parsed, spec.extraConflict);
    const penalties = [];
    if (spec.parsed.reason) penalties.push(spec.parsed.reason);
    if (spec.extraConflict) penalties.push(spec.extraConflict);
    const covered = status === "missing" ? 0 : 1;
    return buildLeadTimeObservation({
      observationType: "lodging_inventory_lead_time",
      role: "feature",
      sourceKey: "lodging.inventory",
      metricKey: spec.metricKey,
      value: spec.parsed.value,
      unit: spec.unit,
      normalization: {
        method: spec.component === "availability_ratio" ? "available_divided_by_total" : "raw_inventory_count",
        version: "v1",
        parameters: {
          component: spec.component,
          missingIsNotZero: true,
          availableMustNotExceedTotal: true
        }
      },
      geo: geoFrom({ ...input, regionKey }),
      observedFrom: observedAt,
      observedTo: observedAt,
      sourceUpdatedAt: temporalText(input.sourceUpdatedAt || observedAt),
      fetchedAt,
      availableAt: availability.availableAt,
      featureAsOf: availability.featureAsOf,
      sample: { n: covered, populationN: 1, unit: "property_observation" },
      coverage: { numerator: covered, denominator: 1, ratio: covered, note: covered ? "inventory field observed" : "inventory field missing" },
      status,
      confidence: confidenceFor(status, penalties),
      rawPayload: { total: totalRaw, available: availableRaw, component: spec.component },
      observedAt,
      targetDate: checkIn,
      checkIn,
      checkOut,
      seriesKey: `${baseSeriesKey}:${spec.component}`,
      runId,
      propertyId,
      regionKey
    });
  });

  return deepFreeze({
    schemaVersion: ADAPTER_SCHEMA_VERSIONS.lodgingInventory,
    signalType: "lodging_inventory_lead_time",
    modelRole: "feature",
    availableAt: availability.availableAt,
    featureAsOf: availability.featureAsOf,
    propertyId,
    regionKey,
    runId,
    checkIn,
    checkOut,
    status: summarizeStatuses(observations.slice(0, 2).map((observation) => observation.status)),
    observations
  });
}

function normalizeRevenueBasis(value) {
  const basis = boundedText(value, 48).toLowerCase();
  if (["settled_actual", "booked_to_date_estimate", "adjusted_estimate"].includes(basis)) return basis;
  throw new SignalAdapterError("INVALID_REVENUE_BASIS", "revenueBasis must identify settled actual or an explicit estimate basis", { revenueBasis: basis });
}

function adaptRegionalRevenue(input = {}) {
  const revenueBasis = normalizeRevenueBasis(input.revenueBasis);
  const estimated = revenueBasis !== "settled_actual";
  const requestedRole = boundedText(input.modelRole, 32).toLowerCase();
  const modelRole = requestedRole || (estimated ? "proxy_target" : input.isFinal === true ? "target" : "descriptive");
  if (estimated && modelRole === "target") {
    throw new SignalAdapterError(
      "ESTIMATED_REVENUE_NOT_TARGET",
      "Booked-to-date or adjusted revenue estimates cannot be used as actual model targets",
      { revenueBasis, modelRole }
    );
  }
  if (modelRole === "target" && input.isFinal !== true) {
    throw new SignalAdapterError("UNSETTLED_REVENUE_NOT_TARGET", "A model target must be final settled actual revenue");
  }
  if (!["target", "proxy_target", "descriptive"].includes(modelRole)) {
    throw new SignalAdapterError("INVALID_REVENUE_MODEL_ROLE", "modelRole must be target, proxy_target, or descriptive", { modelRole });
  }

  const availableAt = requireTime(input.availableAt || input.targetComputedAt, "availableAt");
  const featureAsOf = requireTime(input.featureAsOf, "featureAsOf");
  if (modelRole === "proxy_target" && parsedTime(availableAt) > parsedTime(featureAsOf)) {
    throw new SignalAdapterError(
      "FEATURE_LEAKAGE",
      "A proxy target must have been available at featureAsOf",
      { availableAt, featureAsOf, revenueBasis }
    );
  }

  const base = buildRegionalRevenueTargetFrame({
    ...input,
    revenueBasis,
    modelRole,
    isFinal: input.isFinal === true,
    featureAsOf,
    targetComputedAt: input.targetComputedAt || (modelRole === "target" ? availableAt : "")
  });
  return deepFreeze({
    ...base,
    adapterSchemaVersion: ADAPTER_SCHEMA_VERSIONS.regionalRevenue,
    availableAt,
    featureAsOf,
    revenueBasis,
    modelRole,
    targetEligible: modelRole === "target" && revenueBasis === "settled_actual" && input.isFinal === true
  });
}

module.exports = {
  ADAPTER_SCHEMA_VERSIONS,
  SignalAdapterError,
  adaptLodgingInventoryRow,
  adaptNaverDataLabSeries,
  adaptNaverSearchAdRow,
  adaptNaverSearchAdRows,
  adaptRegionalRevenue,
  parseSearchVolumeValue
};
