"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildMonthlyReportInsights } = require("./monthly_report_insights.cjs");
const { buildMonthlyComparison, previousMonthlyReportRequest } = require("./monthly_report_comparison.cjs");

const SCHEMA_VERSION = 1;
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const PREVIEW_CACHE_BYTES = 32 * 1024 * 1024;
const PRODUCTS = ["lodging", "dayuse"];
const METRICS = ["supply", "sold", "publicBookings", "phoneBookings", "sharedDayUseExcluded", "explicitBlockedBookings"];
const REVENUE_METRICS = ["estimatedRevenue", "publicRevenue", "phoneRevenue", "phoneFallbackRevenue", "phoneFallbackBookings", "phoneMissingPriceBookings"];
const ID_PATTERN = /^mr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.status = statusCode;
  return error;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function number(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}
function ratio(numerator, denominator) { return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : null; }
function dateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "";
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : "";
}
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(value)
    || !dateKey(value.slice(0, 10))) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function kstDate(value) {
  const parsed = value instanceof Date ? value.getTime() : typeof value === "number" ? value : timestamp(value);
  return parsed !== null && Number.isFinite(parsed) ? new Date(parsed + 9 * 3600000).toISOString().slice(0, 10) : "";
}
function calendar(month) {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(String(month || "")) || !dateKey(`${month}-01`)) {
    throw fail("invalid_month", "보고서 대상 월은 YYYY-MM 형식의 유효한 달이어야 합니다.");
  }
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const count = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  const dates = Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
  return { start: dates[0], end: dates.at(-1), days: count, dates };
}
function requestInput(input, now) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("invalid_request", "보고서 조건을 확인해 주세요.");
  const period = calendar(input.month);
  if (!["company", "keyword", "region"].includes(input.type)) throw fail("invalid_report_type", "업체·키워드·지역 중 보고서 유형을 선택해 주세요.");
  const targetId = typeof input.targetId === "string" ? input.targetId.trim() : "";
  if (!targetId || targetId.length > 300 || /[\x00-\x1f\x7f]/.test(targetId)) throw fail("invalid_target", "보고서 대상이 올바르지 않습니다.");
  const cutoffDate = input.cutoffDate === undefined || input.cutoffDate === "" ? [kstDate(now), period.end].sort()[0] : dateKey(input.cutoffDate);
  if (!cutoffDate) throw fail("invalid_cutoff", "관측 기준일은 YYYY-MM-DD 형식의 유효한 날짜여야 합니다.");
  if (cutoffDate > kstDate(now)) throw fail("future_cutoff", "관측 기준일은 오늘 이후로 지정할 수 없습니다.");
  return { type: input.type, month: input.month, targetId, cutoffDate };
}
function textInput(value, field, limit) {
  if (typeof value !== "string" || value.length > limit) throw fail(`invalid_${field}`, `${field === "title" ? "제목" : "메모"} 형식이나 길이를 확인해 주세요.`);
  return value.trim();
}
function runStatus(run = {}) {
  return String(typeof run.collectionQuality === "string" ? run.collectionQuality : run.collectionQuality?.status || "unknown").toLowerCase();
}
function companyIdentity(company = {}) { return String(company.companyId || company.id || company.companyKey || ""); }
function observationIdentity(row = {}) { return String(row.companyId || row.companyKey || ""); }
function rowKey(row) { return JSON.stringify([row.companyId, row.date, row.productType]); }
function compareRows(a, b) { return a.time - b.time || a.tie.localeCompare(b.tie); }
function validCounts(row) {
  const supply = number(row.supply ?? row.total);
  const sold = number(row.sold);
  const publicBookings = number(row.publicBookings);
  const phoneBookings = number(row.phoneBookings);
  if (supply === null || sold === null || publicBookings === null || phoneBookings === null) return "missing_quantity";
  if (sold > supply || Math.abs(sold - publicBookings - phoneBookings) > 0.000001) return "quantity_conflict";
  if ([supply, sold, publicBookings, phoneBookings].some(value => !Number.isInteger(value))) return "quantity_conflict";
  for (const field of ["sharedDayUseExcluded", "explicitBlockedBookings"]) {
    const value = number(row[field]);
    if (Object.hasOwn(row, field) && row[field] !== null && (value === null || !Number.isInteger(value))) return "quantity_conflict";
  }
  if (number(row.explicitBlockedBookings) > phoneBookings) return "quantity_conflict";
  if (row.missing || row.error || row.failed || ["error", "failed", "blocked"].includes(row.status)) return "missing_response";
  if (row.inventoryConflict || row.capacityConflict) return "inventory_conflict";
  if (row.recalculationUnavailable) return "capacity_recalculation_unavailable";
  if (row.partial || row.sharedDayUseIncomplete || number(row.unknownUnavailable) > 0) return "partial_inventory";
  if (Object.hasOwn(row, "reservationRate") && row.reservationRate === null && supply > 0) return "rate_unavailable";
  if (Object.hasOwn(row, "saleRate") && row.saleRate === null && supply > 0) return "rate_unavailable";
  return "";
}
function priceEvidence(row, request) {
  const publicRevenue = number(row.publicRevenue);
  const phoneRevenue = number(row.phoneRevenue);
  const estimatedRevenue = number(row.estimatedRevenue);
  const publicBookings = number(row.publicBookings);
  const phoneBookings = number(row.phoneBookings);
  const valued = publicRevenue !== null && phoneRevenue !== null && estimatedRevenue !== null
    && Math.abs(estimatedRevenue - publicRevenue - phoneRevenue) < 1
    && !(publicBookings === 0 && publicRevenue > 0) && !(phoneBookings === 0 && phoneRevenue > 0);
  const estimates = Array.isArray(row.phonePriceEstimates) ? row.phonePriceEstimates : [];
  const futurePrice = estimates.some(value => !dateKey(value.sourceDate) || value.sourceDate > row.date || value.sourceDate > request.cutoffDate);
  const missingPhonePrice = number(row.phoneMissingPriceBookings) || (phoneBookings > 0 && phoneRevenue === 0 ? phoneBookings : 0);
  const missingPublicPrice = number(row.missingPriceSoldOut) || (publicBookings > 0 && publicRevenue === 0 ? publicBookings : 0);
  const zeroWithoutPrice = publicBookings + phoneBookings > 0 && estimatedRevenue === 0;
  const invalid = !valued || futurePrice || zeroWithoutPrice;
  const reason = futurePrice ? "price_after_cutoff" : !valued ? "inconsistent_revenue" : invalid ? "unpriced_bookings" : "";
  return {
    eligible: !invalid,
    reason,
    estimatedRevenue: invalid ? null : estimatedRevenue,
    publicRevenue: invalid ? null : publicRevenue,
    phoneRevenue: invalid ? null : phoneRevenue,
    phoneFallbackRevenue: invalid ? null : number(row.phoneFallbackRevenue) || 0,
    phoneFallbackBookings: invalid ? null : number(row.phoneFallbackBookings) || 0,
    phoneMissingPriceBookings: missingPhonePrice,
    revenuePartial: !invalid && (missingPhonePrice > 0 || missingPublicPrice > 0 || Boolean(row.explicitBlockedDayUseUnverified)),
    priceEvidenceType: !invalid && number(row.phoneFallbackRevenue) > 0 ? "same_product_observed_fallback" : !invalid ? "stay_date_observed_price" : "none"
  };
}
function knownPartialRevenue(row, request) {
  if (!(row.partial || row.sharedDayUseIncomplete || row.recalculationUnavailable || number(row.unknownUnavailable) > 0) || row.missing
    || row.inventoryConflict || row.capacityConflict) return null;
  const evidence = priceEvidence(row, request);
  // A partial response can substantiate public reservations and explicit blocks,
  // but never turn an unexplained capacity gap into additional revenue.
  if (evidence.reason === "inconsistent_revenue" || evidence.reason === "price_after_cutoff") return null;
  const publicRevenue = number(row.publicRevenue) || 0;
  const blockedRevenue = row.recalculationUnavailable ? 0 : Math.min(number(row.phoneRevenue) || 0, number(row.explicitBlockedRevenue) || 0);
  if (!(publicRevenue + blockedRevenue > 0)) return null;
  return { knownPartialRevenue: publicRevenue + blockedRevenue, knownPartialPublicRevenue: publicRevenue, knownPartialBlockedRevenue: blockedRevenue };
}
function sumKnown(rows, field) {
  return rows.length && rows.every(row => row[field] !== null && row[field] !== undefined)
    ? rows.reduce((sum, row) => sum + row[field], 0) : null;
}
function aggregate(rows, expectedCompanyDays, partialRows = []) {
  const revenueRows = rows.filter(row => row.revenueEligible);
  const totals = Object.fromEntries(METRICS.map(field => [field, sumKnown(rows, field)]));
  const revenue = Object.fromEntries(REVENUE_METRICS.map(field => [field, sumKnown(revenueRows, field)]));
  const leadTimes = rows.map(row => row.observationLeadTimeDays).filter(Number.isFinite).sort((a, b) => a - b);
  const middle = Math.floor(leadTimes.length / 2);
  const median = leadTimes.length ? leadTimes.length % 2 ? leadTimes[middle] : (leadTimes[middle - 1] + leadTimes[middle]) / 2 : null;
  const staleDays = rows.filter(row => row.observationLeadTimeDays > 0).length;
  return {
    ...totals, ...revenue,
    actualRevenue: null,
    reservationRate: totals.supply > 0 ? ratio(totals.sold, totals.supply) : null,
    rateDenominator: "covered_supply",
    coveredSupply: totals.supply,
    coveredCompanyDays: rows.length,
    expectedCompanyDays,
    missingCompanyDays: Math.max(0, expectedCompanyDays - rows.length),
    coverageRate: expectedCompanyDays > 0 ? ratio(rows.length, expectedCompanyDays) : null,
    revenueCoveredCompanyDays: revenueRows.length,
    revenueCoverageRate: expectedCompanyDays > 0 ? ratio(revenueRows.length, expectedCompanyDays) : null,
    sameDayObservedCompanyDays: rows.filter(row => row.observationLeadTimeDays === 0).length,
    staleDays,
    minObservationLeadTimeDays: leadTimes.length ? leadTimes[0] : null,
    maxObservationLeadTimeDays: leadTimes.length ? leadTimes.at(-1) : null,
    medianObservationLeadTimeDays: median,
    partial: rows.length < expectedCompanyDays || staleDays > 0 || rows.some(row => row.runQuality === "partial"),
    revenuePartial: revenueRows.length < expectedCompanyDays || revenueRows.some(row => row.revenuePartial || row.runQuality === "partial") || partialRows.length > 0,
    containsPartialRun: rows.some(row => row.runQuality === "partial"),
    knownPartialRevenue: sumKnown(partialRows, "knownPartialRevenue"),
    knownPartialPublicRevenue: sumKnown(partialRows, "knownPartialPublicRevenue"),
    knownPartialBlockedRevenue: sumKnown(partialRows, "knownPartialBlockedRevenue"),
    knownPartialCompanyDays: partialRows.length,
    runIds: [...new Set([...rows, ...partialRows].map(row => row.runId))].sort()
  };
}
function pairedChanges(groups) {
  const rows = [];
  let discardedCapacityPairs = 0;
  for (const group of groups.values()) {
    group.sort(compareRows);
    const first = group[0];
    const last = group.at(-1);
    if (first.time === last.time) continue;
    if (first.supply !== last.supply) { discardedCapacityPairs += 1; continue; }
    const revenueComparable = first.revenueEligible && last.revenueEligible;
    rows.push({
      companyId: last.companyId, companyName: last.companyName, date: last.date, productType: last.productType,
      firstCollectedAt: first.collectedAt, lastCollectedAt: last.collectedAt,
      firstRunId: first.runId, lastRunId: last.runId, observationCount: new Set(group.map(row => row.time)).size,
      firstSold: first.sold, lastSold: last.sold, soldChange: last.sold - first.sold,
      firstEstimatedRevenue: revenueComparable ? first.estimatedRevenue : null,
      lastEstimatedRevenue: revenueComparable ? last.estimatedRevenue : null,
      estimatedRevenueChange: revenueComparable ? last.estimatedRevenue - first.estimatedRevenue : null
    });
  }
  const summarize = product => {
    const selected = rows.filter(row => row.productType === product);
    const revenue = selected.filter(row => row.estimatedRevenueChange !== null);
    return {
      comparablePairs: selected.length, revenueComparablePairs: revenue.length,
      firstSold: sumKnown(selected, "firstSold"), lastSold: sumKnown(selected, "lastSold"), soldChange: sumKnown(selected, "soldChange"),
      firstEstimatedRevenue: sumKnown(revenue, "firstEstimatedRevenue"), lastEstimatedRevenue: sumKnown(revenue, "lastEstimatedRevenue"),
      estimatedRevenueChange: sumKnown(revenue, "estimatedRevenueChange")
    };
  };
  return { lodging: summarize("lodging"), dayuse: summarize("dayuse"), rows, discardedCapacityPairs };
}
function keywordMembership(request, period, observations, rankObservations, runMap) {
  const members = new Set();
  const inventoryMembers = new Set();
  const rankMembers = new Set();
  const sourceTime = row => {
    const run = runMap.get(String(row.runId || ""));
    if (!run || !["complete", "reused", "partial"].includes(runStatus(run))
      || String(row.keyword || run.keyword || "") !== request.targetId
      || (!row.collectedAt && run.collectedAtSource === "filesystem")) return "";
    const day = kstDate(timestamp(String(row.collectedAt || run.collectedAt || "")));
    return day && day <= request.cutoffDate ? day : "";
  };
  for (const row of observations) {
    const collectedDate = sourceTime(row);
    const stayDate = dateKey(row.stayDate || row.date);
    const productType = row.productType === "day-use" ? "dayuse" : row.productType;
    if (!collectedDate || !stayDate || stayDate < period.start || stayDate > period.end || collectedDate > stayDate
      || !PRODUCTS.includes(productType) || !(number(row.inventoryEvidenceVersion ?? row.evidenceVersion) >= 3)) continue;
    // A quality-eligible run identifies the company for this stay month even
    // when its inventory response is missing. The missing response stays null.
    const id = observationIdentity(row);
    if (id) { members.add(id); inventoryMembers.add(id); }
  }
  for (const row of [...rankObservations, ...observations]) {
    const day = sourceTime(row);
    const rank = number(row.rank);
    if (!day || day < period.start || day > period.end || !(rank >= 1) || !Number.isInteger(rank)) continue;
    const id = observationIdentity(row);
    if (id) { members.add(id); rankMembers.add(id); }
  }
  return { members, inventoryMembers, rankMembers };
}
function monthlyReportKeywordMembership(request, source = {}) {
  const observations = Array.isArray(source.observations) ? source.observations : [];
  const rankObservations = Array.isArray(source.rankObservations) ? source.rankObservations : [];
  const runs = Array.isArray(source.runs) ? source.runs : [];
  return keywordMembership(request, calendar(request.month), observations, rankObservations,
    new Map(runs.map(run => [String(run.id || run.runId || ""), run])));
}
function rankChanges(observations, companies, runMap, request, period) {
  const groups = new Map();
  for (const source of observations) {
    const companyId = observationIdentity(source);
    const run = runMap.get(String(source.runId || ""));
    if (!companies.has(companyId) || !run || !["complete", "reused", "partial"].includes(runStatus(run))) continue;
    const keyword = String(source.keyword || run.keyword || "");
    if (!keyword || (request.type === "keyword" && keyword !== request.targetId)) continue;
    const collectedAt = String(source.collectedAt || run.collectedAt || "");
    if (!source.collectedAt && run.collectedAtSource === "filesystem") continue;
    const time = timestamp(collectedAt);
    const day = kstDate(time);
    const rank = number(source.rank);
    if (time === null || day < period.start || day > period.end || day > request.cutoffDate || !(rank >= 1) || !Number.isInteger(rank)) continue;
    const key = JSON.stringify([companyId, keyword]);
    const group = groups.get(key) || new Map();
    group.set(`${time}:${source.runId}`, { companyId, companyName: companies.get(companyId).primaryName, keyword, rank, time, collectedAt, runId: String(source.runId), tie: String(source.runId) });
    groups.set(key, group);
  }
  const rows = [...groups.values()].map(group => {
    const ordered = [...group.values()].sort(compareRows);
    const first = ordered[0], last = ordered.at(-1);
    return { companyId: last.companyId, companyName: last.companyName, keyword: last.keyword, firstRank: first.rank, lastRank: last.rank,
      rankImprovement: first.time !== last.time ? first.rank - last.rank : null,
      firstCollectedAt: first.collectedAt, lastCollectedAt: last.collectedAt,
      firstRunId: first.runId, lastRunId: last.runId, observations: ordered.length };
  }).sort((a, b) => a.companyId.localeCompare(b.companyId) || a.keyword.localeCompare(b.keyword));
  return { rows, comparableSeries: rows.filter(row => row.rankImprovement !== null).length,
    period: { start: period.start, end: period.end, cutoffDate: request.cutoffDate }, basis: "동일 업체·동일 키워드의 해당 월 첫 관측과 마지막 관측. 양수는 순위 상승." };
}

function buildSnapshot(request, source, generatedAt) {
  const { dates, ...period } = calendar(request.month);
  period.cutoffDate = request.cutoffDate;
  period.monthClosed = kstDate(generatedAt) > period.end;
  const observations = Array.isArray(source?.observations) ? source.observations : [];
  const rankObservations = Array.isArray(source?.rankObservations) ? source.rankObservations : [];
  const runs = Array.isArray(source?.runs) ? source.runs : [];
  const runMap = new Map(runs.map(run => [String(run.id || run.runId || ""), run]));
  const membership = request.type === "keyword" ? keywordMembership(request, period, observations, rankObservations, runMap) : null;
  const companyMap = new Map();
  for (const value of Array.isArray(source?.companies) ? source.companies : []) {
    const companyId = companyIdentity(value);
    if (!companyId || (request.type === "company" && companyId !== request.targetId)
      || (request.type === "region" && String(value.regionKey || "") !== request.targetId && !(Array.isArray(value.regionKeys) && value.regionKeys.includes(request.targetId)))
      || (request.type === "keyword" && !membership.members.has(companyId))) continue;
    companyMap.set(companyId, { companyId, primaryName: String(value.primaryName || value.companyName || value.name || companyId), regionKey: String(value.regionKey || ""), regionLabel: String(value.regionLabel || ""),
      capacity: number(value.capacity), capacitySource: String(value.capacitySource || "") });
  }
  const target = { type: request.type, id: request.targetId, label: request.type === "company" ? companyMap.get(request.targetId)?.primaryName || request.targetId
    : request.type === "region" ? (source?.regions || []).find(region => region.id === request.targetId)?.label || request.targetId : request.targetId };
  const discardedByReason = {};
  const discarded = [];
  const groups = new Map(), partialGroups = new Map(), selectedRunIds = new Set();
  const seen = new Set();
  const scopedRuns = new Map();
  let scopedObservationCount = 0, eligibleObservationCount = 0, partialRunObservationCount = 0;
  const discard = (reason, row) => {
    discardedByReason[reason] = (discardedByReason[reason] || 0) + 1;
    // Keep a bounded explanation sample instead of serializing source payloads.
    if (discarded.length < 100) discarded.push({ companyId: observationIdentity(row), date: row.date || row.stayDate || "", productType: row.productType || "", runId: String(row.runId || ""), reason });
  };
  for (const original of observations) {
    const companyId = observationIdentity(original);
    if (!companyMap.has(companyId)) continue;
    const date = dateKey(original.stayDate || original.date);
    if (date && (date < period.start || date > period.end)) continue;
    const runId = String(original.runId || "");
    const run = runMap.get(runId);
    const keyword = String(original.keyword || run?.keyword || "");
    if (request.type === "keyword" && keyword !== request.targetId) continue;
    scopedObservationCount += 1;
    if (run) scopedRuns.set(runId, (scopedRuns.get(runId) || 0) + 1);
    if (!date) { discard("invalid_stay_date", original); continue; }
    const productType = original.productType === "day-use" ? "dayuse" : original.productType;
    if (!PRODUCTS.includes(productType)) { discard("invalid_product_type", original); continue; }
    const quality = runStatus(run);
    if (!run || !["complete", "reused", "partial"].includes(quality)) { discard(!run || quality === "unknown" ? "unknown_legacy_run_quality" : `run_${quality}`, original); continue; }
    const collectedAt = String(original.collectedAt || run.collectedAt || "");
    if (!original.collectedAt && run.collectedAtSource === "filesystem") { discard("unverified_collection_time", original); continue; }
    const time = timestamp(collectedAt);
    if (time === null) { discard("invalid_collection_time", original); continue; }
    const collectedDate = kstDate(time);
    if (collectedDate > request.cutoffDate) { discard("after_cutoff", original); continue; }
    if (collectedDate > date) { discard("post_stay_observation", original); continue; }
    if (!(number(original.inventoryEvidenceVersion ?? original.evidenceVersion) >= 3)) { discard("legacy_inventory_evidence", original); continue; }
    if (productType === "dayuse" && (original.dayUsePresence === "absent"
      || (original.dayUseScheduleStatus && original.dayUseScheduleStatus !== "requested"))) { discard("dayuse_unobserved", original); continue; }
    const row = { ...original, companyId, companyName: companyMap.get(companyId).primaryName, date, productType,
      runId, keyword, runQuality: quality, collectedAt, collectedDate, time,
      tie: `${runId}:${String(original.observationId || "")}:${crypto.createHash("sha256").update(JSON.stringify(original)).digest("hex")}` };
    const duplicateKey = `${rowKey(row)}:${runId}:${collectedAt}:${original.observationId || crypto.createHash("sha256").update(JSON.stringify(original)).digest("hex")}`;
    if (seen.has(duplicateKey)) { discard("duplicate_observation", row); continue; }
    seen.add(duplicateKey);
    const countError = validCounts(row);
    if (countError) {
      const partialRevenue = knownPartialRevenue(row, request);
      if (partialRevenue) {
        const previous = partialGroups.get(rowKey(row));
        if (!previous || compareRows(row, previous) > 0) partialGroups.set(rowKey(row), { ...row, ...partialRevenue });
      }
      discard(countError, row);
      continue;
    }
    const valuation = priceEvidence(row, request);
    const normalized = {
      companyId, companyName: row.companyName, date, productType, runId, keyword, runQuality: quality,
      collectedAt, collectedDate, time, tie: row.tie,
      observationLeadTimeDays: Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${collectedDate}T00:00:00Z`)) / 86400000),
      inventoryEvidenceVersion: number(original.inventoryEvidenceVersion ?? original.evidenceVersion),
      supply: number(row.supply ?? row.total), sold: number(row.sold), publicBookings: number(row.publicBookings), phoneBookings: number(row.phoneBookings),
      sharedDayUseExcluded: number(row.sharedDayUseExcluded) || 0, explicitBlockedBookings: number(row.explicitBlockedBookings) || 0,
      ...valuation, revenueEligible: valuation.eligible, revenueMissingReason: valuation.reason,
      phonePriceEstimates: Array.isArray(row.phonePriceEstimates) ? clone(row.phonePriceEstimates) : [],
      capacityBasis: row.capacityBasis ? clone(row.capacityBasis) : null,
      dayUseSharingStatus: String(row.dayUseSharingStatus || ""),
      phoneValuationPolicy: String(row.phoneValuationPolicy || "")
    };
    const key = rowKey(row);
    const group = groups.get(key) || [];
    group.push(normalized);
    groups.set(key, group);
    eligibleObservationCount += 1;
    if (quality === "partial") partialRunObservationCount += 1;
  }
  const selected = [];
  for (const group of groups.values()) {
    group.sort(compareRows);
    const row = group.at(-1);
    selected.push(row);
    selectedRunIds.add(row.runId);
    for (const older of group.slice(0, -1)) discard("superseded_observation", older);
  }
  selected.sort((a, b) => a.date.localeCompare(b.date) || a.companyId.localeCompare(b.companyId) || a.productType.localeCompare(b.productType));
  const selectedKeys = new Set(selected.map(rowKey));
  const partialRows = [...partialGroups.entries()].filter(([key]) => !selectedKeys.has(key)).map(([, row]) => row);
  for (const row of partialRows) selectedRunIds.add(row.runId);
  const summaryFor = (rows, partials, expected) => Object.fromEntries(PRODUCTS.map(product => [product, aggregate(rows.filter(row => row.productType === product), expected, partials.filter(row => row.productType === product))]));
  const dailyFor = (rows, partials, companyCount) => dates.map(date => ({ date,
    ...summaryFor(rows.filter(row => row.date === date), partials.filter(row => row.date === date), companyCount) }));
  const expectedCompanyDays = companyMap.size * period.days;
  const summary = summaryFor(selected, partialRows, expectedCompanyDays);
  const companies = [...companyMap.values()].map(company => {
    const rows = selected.filter(row => row.companyId === company.companyId);
    const partials = partialRows.filter(row => row.companyId === company.companyId);
    return { ...company, summary: summaryFor(rows, partials, period.days), daily: dailyFor(rows, partials, 1) };
  });
  const selectedCounts = new Map();
  for (const row of [...selected, ...partialRows]) selectedCounts.set(row.runId, (selectedCounts.get(row.runId) || 0) + 1);
  const ranks = rankChanges([...rankObservations, ...observations], companyMap, runMap, request, period);
  const rankSourceCounts = new Map();
  for (const rank of ranks.rows) {
    for (const id of new Set([rank.firstRunId, rank.lastRunId])) {
      if (!scopedRuns.has(id)) scopedRuns.set(id, 0);
      selectedRunIds.add(id);
      rankSourceCounts.set(id, (rankSourceCounts.get(id) || 0) + 1);
    }
  }
  const sourceRuns = [...scopedRuns.entries()].map(([id, count]) => {
    const run = runMap.get(id);
    return { id, keyword: String(run.keyword || ""), collectedAt: String(run.collectedAt || ""), collectionQuality: { status: runStatus(run) }, observationCount: count, selectedObservationCount: selectedCounts.get(id) || 0, rankSeriesCount: rankSourceCounts.get(id) || 0 };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const discardedObservationCount = Object.values(discardedByReason).reduce((sum, value) => sum + value, 0);
  const revenueExcludedCompanyDays = selected.filter(row => row.productType === "lodging" && !row.revenueEligible).length;
  const warnings = (Array.isArray(source?.warnings) ? source.warnings : []).filter(value => typeof value === "string").map(value => value.slice(0, 1000));
  if (!companyMap.size) warnings.push("선택 조건에 해당하는 업체를 확인하지 못했습니다.");
  if (summary.lodging.missingCompanyDays) warnings.push(`숙박 관측 ${summary.lodging.coveredCompanyDays}/${expectedCompanyDays} 업체·일. 결측 날짜는 0으로 계산하지 않았습니다.`);
  if (partialRunObservationCount) warnings.push("부분 완료 회차의 유효 업체 관측을 포함한 제한적 소계입니다.");
  if (summary.lodging.staleDays) warnings.push(`${summary.lodging.staleDays} 업체·일은 숙박일 이전의 마지막 관측입니다. 월간 관측 커버리지가 100%여도 최종 예약·실제 매출을 뜻하지 않습니다.`);
  if (partialRows.length) warnings.push("부분 응답에서 근거가 확인된 금액은 별도 소계이며 정상 예상매출과 합산하지 않습니다.");
  if (revenueExcludedCompanyDays || summary.lodging.revenuePartial) warnings.push("가격 미확인 또는 미수집 날짜가 있어 예상매출은 확인된 날짜의 소계입니다.");
  if (discardedByReason.unknown_legacy_run_quality || discardedByReason.legacy_inventory_evidence) warnings.push("수집 품질 또는 재고 근거 버전을 확인할 수 없는 과거 자료를 제외했습니다.");
  if (!period.monthClosed) warnings.push("아직 종료되지 않은 달의 중간 집계입니다.");
  if (period.end > request.cutoffDate) warnings.push("월 종료 전 기준일 보고서입니다. 향후 숙박일의 예약 관측이 포함될 수 있습니다.");
  const sourceQualityLimited = Boolean(source?.warnings?.length) || Object.values(source?.sourceDiagnostics || {}).some(value => typeof value === "number" && value > 0);
  const quality = {
    status: !summary.lodging.coveredCompanyDays ? "insufficient" : summary.lodging.partial || summary.lodging.revenuePartial || !period.monthClosed || sourceQualityLimited ? "partial" : "complete",
    provisional: !period.monthClosed,
    companyCount: companyMap.size, expectedCompanyDays, coveredCompanyDays: summary.lodging.coveredCompanyDays,
    coverageRate: summary.lodging.coverageRate, missingCompanyDays: summary.lodging.missingCompanyDays,
    sameDayObservedCompanyDays: summary.lodging.sameDayObservedCompanyDays, staleDays: summary.lodging.staleDays,
    minObservationLeadTimeDays: summary.lodging.minObservationLeadTimeDays,
    maxObservationLeadTimeDays: summary.lodging.maxObservationLeadTimeDays,
    medianObservationLeadTimeDays: summary.lodging.medianObservationLeadTimeDays,
    revenueCoveredCompanyDays: summary.lodging.revenueCoveredCompanyDays, revenueExcludedCompanyDays,
    discardedObservationCount, discardedByReason, discardedSamples: discarded, partialRunObservationCount,
    knownPartialCompanyDays: partialRows.filter(row => row.productType === "lodging").length, warnings,
    sourceDiagnostics: source?.sourceDiagnostics ? clone(source.sourceDiagnostics) : null,
    globalWarnings: (Array.isArray(source?.globalWarnings) ? source.globalWarnings : []).filter(value => typeof value === "string").map(value => value.slice(0, 1000)),
    globalDiagnostics: source?.globalDiagnostics ? clone(source.globalDiagnostics) : null
  };
  const cleanSelected = selected.map(({ time, tie, eligible, reason, ...row }) => row);
  const insights = buildMonthlyReportInsights({ request, period, companies: [...companyMap.values()],
    observations: [...groups.values()].flat(), selected, rankObservations: [...rankObservations, ...observations], runs, specialDays: source?.specialDays });
  // Timing/distribution uses intermediate observations as well as the selected
  // final values. Preserve those run references in the issued report's sources.
  const listedRunIds = new Set(sourceRuns.map(run => run.id));
  for (const id of insights.sourceRunIds) {
    selectedRunIds.add(id);
    if (listedRunIds.has(id)) continue;
    const run = runMap.get(id);
    if (run) sourceRuns.push({ id, keyword: String(run.keyword || ""), collectedAt: String(run.collectedAt || ""),
      collectionQuality: { status: runStatus(run) }, observationCount: 0, selectedObservationCount: 0, rankSeriesCount: 0 });
  }
  sourceRuns.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: SCHEMA_VERSION, generatedAt, request: clone(request), period, target,
    summary, daily: dailyFor(selected, partialRows, companyMap.size), companies,
    changes: pairedChanges(groups), ranks, insights,
    quality,
    sources: {
      runIds: [...selectedRunIds].sort(), partialRunIds: sourceRuns.filter(run => run.collectionQuality.status === "partial" && run.selectedObservationCount).map(run => run.id),
      runs: sourceRuns, scopedObservationCount, eligibleObservationCount, selectedObservationCount: selected.length, discardedObservationCount,
      targetMembership: request.type === "keyword" ? {
        basis: "selected_month_rank_or_stay_observation",
        companyIds: [...companyMap.keys()].sort(),
        rankOnlyCompanyIds: [...companyMap.keys()].filter(id => membership.rankMembers.has(id) && !membership.inventoryMembers.has(id)).sort()
      } : { basis: request.type === "company" ? "canonical_company_id" : "current_company_region", companyIds: [...companyMap.keys()].sort() },
      excludedRuns: sourceRuns.filter(run => !["complete", "reused", "partial"].includes(run.collectionQuality.status)).map(run => ({ id: run.id, status: run.collectionQuality.status, reason: "ineligible_run_quality" })),
      observations: cleanSelected,
      partialEvidence: [...partialGroups.entries()].map(([key, row]) => ({ companyId: row.companyId, date: row.date, productType: row.productType, runId: row.runId,
        collectedAt: row.collectedAt, knownPartialRevenue: row.knownPartialRevenue, knownPartialPublicRevenue: row.knownPartialPublicRevenue,
        knownPartialBlockedRevenue: row.knownPartialBlockedRevenue, includedInPartialSubtotal: !selectedKeys.has(key), reason: row.recalculationUnavailable ? "capacity_recalculation_unavailable" : "partial_inventory" })),
      observationPolicy: "latest_valid_per_company_stay_date_product_type_kst_no_post_stay",
      digest: crypto.createHash("sha256").update(JSON.stringify(cleanSelected)).digest("hex")
    },
    context: source?.context ? clone(source.context) : null,
    definitions: {
      month: "수집한 달이 아니라 숙박일이 속한 달(한국시간)의 전체 달력 일수를 기준으로 집계합니다.",
      keywordMembership: "키워드 보고서는 해당 월의 유효 순위 관측 또는 해당 월 숙박일의 관측으로 확인된 업체를 대상으로 합니다. 과거·미래의 키워드 등록 이력만 있는 업체는 제외하며, 해당 월 순위만 확인된 업체의 재고는 결측으로 남깁니다.",
      latestObservation: "동일 업체·숙박일·상품유형에서 기준일 이하이고 숙박일 이후가 아닌 최신 유효 관측을 한 번만 반영합니다. 키워드·회차별 스냅샷을 더하지 않습니다.",
      coverage: "선택 업체 수 × 해당 월 전체 일수를 분모로 관측 커버리지를 표시합니다. 미수집·오류·미확인 값은 0이 아닌 결측입니다.",
      observationFreshness: "숙박 당일 관측 업체·일과 이전 관측 업체·일을 구분합니다. 관측 선행일수는 숙박일에서 마지막 유효 관측일을 뺀 한국시간 일수이며, 당일 관측도 최종 확정 예약이나 실제 결제 자료를 뜻하지 않습니다.",
      reservationRate: "유효하게 관측된 숙박 예약 추정 수량 ÷ 같은 관측의 숙박 공급 수량. 월 전체 점유율이나 실제 확정 예약률이 아닙니다.",
      estimatedRevenue: "공개 예약 금액과 전화·타채널 예약 추정 금액 중 가격 근거가 확인된 날짜의 원화 소계입니다. 실제 결제 매출이 아닙니다.",
      phoneBookings: "재고 근거에 따른 전화·타채널 예약 추정 수량입니다. 명시적 방막기는 이 수량의 일부이며 다시 더하지 않습니다.",
      knownPartialRevenue: "부분 응답의 공개예약 금액과 명시적 방막기 금액만 별도 표시합니다. 정상 예상매출과 합산하지 않으며 설명되지 않은 재고 차이는 제외합니다.",
      dayuse: "당일 이용의 수량·매출은 숙박 객실박 수량·매출과 별도입니다. 미조회 당일 이용은 0으로 취급하지 않습니다.",
      changes: "동일 업체·숙박일·상품유형과 동일 공급 수량의 첫·마지막 유효 관측만 비교합니다. 변화량은 신규 예약 확정 건수가 아닙니다.",
      ranks: "해당 월에 관측된 동일 업체·동일 키워드 순위의 첫·마지막 값입니다. 지역 전체 시장의 평균 순위가 아닙니다.",
      context: "외부 통계는 대상 기간·공표 시점·출처를 따로 읽는 배경 자료이며 개별 숙소 매출의 원인으로 단정하지 않습니다.",
      publication: "발행본의 숫자·메모·근거는 고정됩니다. 수정본은 별도 ID와 버전으로 생성됩니다."
    }
  };
}

function createMonthlyReportService({ dataDir, loadSources, now = () => new Date() } = {}) {
  if (typeof dataDir !== "string" || !dataDir || typeof loadSources !== "function") throw new TypeError("dataDir and loadSources are required");
  const directory = path.resolve(dataDir);
  const previews = new Map();
  let previewBytes = 0;
  let buildQueue = Promise.resolve();
  const current = () => {
    const value = typeof now === "function" ? now() : now;
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("now must return a valid date");
    return date;
  };
  const reportPath = id => {
    if (!ID_PATTERN.test(String(id || ""))) throw fail("invalid_report_id", "보고서 ID가 올바르지 않습니다.");
    return path.join(directory, `${id}.json`);
  };
  const read = async id => {
    let content;
    try { content = await fs.readFile(reportPath(id), "utf8"); }
    catch (error) { if (error.code === "ENOENT") throw fail("report_not_found", "보고서를 찾을 수 없습니다.", 404); throw error; }
    try {
      const report = JSON.parse(content);
      if (report.id !== id || report.schemaVersion !== SCHEMA_VERSION || !report.snapshot) throw new Error("Invalid report");
      if (report.status === "published" && (!report.snapshotHash
        || report.snapshotHash !== crypto.createHash("sha256").update(JSON.stringify(report.snapshot)).digest("hex"))) throw new Error("Snapshot hash mismatch");
      return report;
    } catch { throw fail("corrupt_report", "저장된 보고서를 읽을 수 없습니다. 원본 파일은 보존했습니다.", 500); }
  };
  const write = async report => {
    await fs.mkdir(directory, { recursive: true });
    const destination = reportPath(report.id);
    const temp = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, "wx");
      try { await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, destination);
    } finally { await fs.unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  };
  const locked = async (id, action) => {
    const file = `${reportPath(id)}.lock`;
    await fs.mkdir(directory, { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { handle = await fs.open(file, "wx"); break; }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (attempt === 99) {
          const stat = await fs.stat(file).catch(() => null);
          const mayBeStale = stat && Date.now() - stat.mtimeMs > 5 * 60 * 1000;
          const error = fail("report_busy", mayBeStale
            ? "이전 저장 잠금이 남아 있을 수 있습니다. 원본 보고서는 조회할 수 있으며, 계속 저장되지 않으면 운영자에게 잠금 상태 점검을 요청해 주세요."
            : "다른 작업이 보고서를 저장 중입니다. 보고서를 다시 열어 저장 상태를 확인한 뒤 다시 시도해 주세요.", 423);
          error.lockMayBeStale = Boolean(mayBeStale);
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try { return await action(); }
    finally { await handle.close(); await fs.unlink(file); }
  };
  const checkRevision = (report, revision) => {
    if (!Number.isInteger(revision) || revision < 1) throw fail("revision_required", "저장된 보고서의 revision이 필요합니다.");
    if (report.revision !== revision) throw fail("revision_conflict", "다른 변경이 먼저 저장되었습니다. 보고서를 다시 열어 주세요.", 409);
  };
  const build = (request, generatedAt) => {
    const task = buildQueue.then(async () => {
      const snapshot = buildSnapshot(request, await loadSources(clone(request)), generatedAt);
      const previousRequest = previousMonthlyReportRequest(request);
      const previous = buildSnapshot(previousRequest, await loadSources(clone(previousRequest)), generatedAt);
      snapshot.comparison = buildMonthlyComparison(snapshot, previous);
      return snapshot;
    });
    buildQueue = task.then(() => undefined, () => undefined);
    return task;
  };
  const removePreview = token => {
    const entry = previews.get(token);
    if (entry) previewBytes -= entry.bytes;
    previews.delete(token);
  };
  const preview = async input => {
    const date = current();
    const request = requestInput(input, date);
    const snapshot = await build(request, date.toISOString());
    const previewToken = crypto.randomUUID();
    for (const [token, entry] of previews) if (entry.expires <= date.getTime()) removePreview(token);
    const serialized = JSON.stringify(snapshot);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > PREVIEW_CACHE_BYTES) throw fail("report_too_large", "보고서 근거가 너무 큽니다. 업체 또는 더 작은 지역 단위로 나누어 주세요.", 413);
    // Bound session memory without ever accepting a browser supplied snapshot.
    while (previews.size && (previews.size >= 10 || previewBytes + bytes > PREVIEW_CACHE_BYTES)) removePreview(previews.keys().next().value);
    previews.set(previewToken, { expires: current().getTime() + PREVIEW_TTL_MS, request: JSON.stringify(request), serialized, bytes });
    previewBytes += bytes;
    return { ...snapshot, previewToken };
  };
  const create = async input => {
    const date = current();
    const request = requestInput(input, date);
    let snapshot;
    if (input.previewToken !== undefined) {
      const entry = previews.get(input.previewToken);
      if (!entry || entry.expires <= date.getTime()) throw fail("preview_expired", "미리보기가 만료되었습니다. 다시 확인한 뒤 초안을 저장해 주세요.", 409);
      if (entry.request !== JSON.stringify(request)) throw fail("preview_mismatch", "미리보기 조건과 저장 조건이 다릅니다. 다시 미리보기해 주세요.", 409);
      snapshot = JSON.parse(entry.serialized);
    } else snapshot = await build(request, date.toISOString());
    const id = `mr_${crypto.randomUUID()}`;
    const report = { schemaVersion: SCHEMA_VERSION, id, revision: 1, status: "draft", ...request,
      title: input.title === undefined ? `${request.month.slice(0, 4)}년 ${Number(request.month.slice(5))}월 ${snapshot.target.label} ${request.type === "keyword" ? "검색시장 리포트" : "월간 보고서"}` : textInput(input.title, "title", 200),
      notes: input.notes === undefined ? "" : textInput(input.notes, "notes", 20000),
      createdAt: date.toISOString(), updatedAt: date.toISOString(), publishedAt: null, version: 1, supersedesId: null, snapshot };
    await write(report);
    return clone(report);
  };
  const list = async () => {
    let entries;
    try { entries = await fs.readdir(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const reports = await Promise.all(entries.filter(name => name.endsWith(".json") && ID_PATTERN.test(name.slice(0, -5))).map(name => read(name.slice(0, -5))));
    return reports.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).map(report => {
      const { snapshot, ...metadata } = report;
      return { ...metadata, summary: snapshot.summary, quality: snapshot.quality, target: snapshot.target };
    });
  };
  const update = async (id, input = {}) => locked(id, async () => {
    const report = await read(id);
    checkRevision(report, input.revision);
    if (report.status === "published") throw fail("published_immutable", "발행된 보고서는 수정할 수 없습니다. 수정본을 생성해 주세요.", 409);
    const permitted = new Set(["revision", "title", "notes", "status"]);
    if (Object.keys(input).some(key => !permitted.has(key))) throw fail("immutable_snapshot", "보고서 숫자와 근거는 직접 수정할 수 없습니다.");
    if (input.title !== undefined) report.title = textInput(input.title, "title", 200);
    if (input.notes !== undefined) report.notes = textInput(input.notes, "notes", 20000);
    if (input.status !== undefined) {
      if (!["draft", "review"].includes(input.status)) throw fail("invalid_report_status", "초안 또는 검토 상태만 저장할 수 있습니다.");
      report.status = input.status;
    }
    report.revision += 1;
    report.updatedAt = current().toISOString();
    await write(report);
    return clone(report);
  });
  const publish = async (id, input = {}) => locked(id, async () => {
    const report = await read(id);
    if (report.status === "published") {
      if (input.revision === report.revision || input.revision === report.publishedFromRevision) return clone(report);
      checkRevision(report, input.revision);
    }
    checkRevision(report, input.revision);
    if (report.status !== "review") throw fail("review_required", "검토 상태로 저장한 보고서만 발행할 수 있습니다.", 409);
    if (report.snapshot.quality.status !== "complete" && input.acknowledgeQuality !== true) {
      throw fail("quality_acknowledgement_required", "관측 누락과 부분 합계 안내를 확인한 뒤 발행해 주세요.", 409);
    }
    report.publishedFromRevision = report.revision;
    report.revision += 1;
    report.status = "published";
    report.publishedAt = current().toISOString();
    report.updatedAt = report.publishedAt;
    report.qualityAcknowledged = input.acknowledgeQuality === true;
    report.snapshotHash = crypto.createHash("sha256").update(JSON.stringify(report.snapshot)).digest("hex");
    await write(report);
    return clone(report);
  });
  const revise = async (id, input = {}) => locked(id, async () => {
    const original = await read(id);
    checkRevision(original, input.revision);
    if (original.status !== "published") throw fail("published_required", "발행된 보고서에서 수정본을 생성할 수 있습니다.", 409);
    const date = current().toISOString();
    const report = { ...clone(original), id: `mr_${crypto.randomUUID()}`, revision: 1, status: "draft", version: original.version + 1,
      supersedesId: original.id, createdAt: date, updatedAt: date, publishedAt: null };
    delete report.publishedFromRevision;
    delete report.qualityAcknowledged;
    delete report.snapshotHash;
    await write(report);
    return clone(report);
  });
  const rebuild = async (id, input = {}) => locked(id, async () => {
    const report = await read(id);
    checkRevision(report, input.revision);
    if (report.status === "published") throw fail("published_immutable", "발행된 보고서는 재집계할 수 없습니다. 수정본을 생성해 주세요.", 409);
    const date = current();
    const request = requestInput(report, date);
    report.snapshot = await build(request, date.toISOString());
    report.status = "draft";
    report.revision += 1;
    report.updatedAt = date.toISOString();
    await write(report);
    return clone(report);
  });
  return { preview, create, list, get: read, update, publish, revise, rebuild };
}

module.exports = { createMonthlyReportService, buildMonthlyReportSnapshot: buildSnapshot, monthlyReportKeywordMembership };
