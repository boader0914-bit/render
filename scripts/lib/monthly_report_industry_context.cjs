"use strict";

// Read saved industry results only. This adapter has no calculator or queue.
const MAX_ENTRIES = 48;
const IDS = new Map([["glamping", "글램핑"], ["campground", "캠핑장"], ["caravan", "카라반"], ["pension", "펜션"],
  ["poolVilla", "풀빌라"], ["privateStay", "독채숙소"], ["hotelResort", "호텔/리조트"], ["motel", "모텔"]]);
const SUMMARY_KEYS = ["companyCount", "observedCompanies", "coveredCompanyDays", "expectedCompanyDays", "missingCompanyDays", "coverageRate",
  "reservationRate", "publicBookings", "phoneBookings", "sold", "supply", "estimatedRevenue", "publicRevenue", "phoneRevenue",
  "revenueCoveredCompanyDays", "sameDayObservedCompanyDays", "averageBookedPrice", "revenuePerAvailableUnitDay"];
const STORAGE_KEYS = ["key", "resultVersion", "calculationVersion", "sourceRevision", "resultRevision", "calculatedAt", "status", "stale", "hasSnapshot", "sourceRevisionMatches", "errorCode"];
const STATUSES = new Set(["ready", "stale", "queued", "processing", "failed", "missing", "unavailable"]);
const text = (value, max = 400) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, max) : "";
const reasons = Object.freeze({ NO_SAVED_INDUSTRY_AGGREGATE: "같은 업종·지역·기간의 저장 집계가 없습니다. 업종분석에서 먼저 준비해 주세요.",
  INDUSTRY_AGGREGATE_STALE: "마지막 정상 저장본입니다. 새 자료나 객실 검수값의 반영 상태를 확인해 주세요.",
  INDUSTRY_AGGREGATE_PENDING: "해당 조건의 업종 집계를 준비하고 있습니다.", INDUSTRY_AGGREGATE_FAILED: "최근 집계에 실패했습니다. 저장본과 실패 사유를 함께 확인해 주세요.",
  INDUSTRY_AGGREGATE_INVALID: "저장 집계의 조건이나 근거를 확인하지 못했습니다.", INDUSTRY_AGGREGATE_READ_FAILED: "저장된 업종 집계를 읽지 못했습니다.",
  INDUSTRY_SERVICE_UNAVAILABLE: "업종 저장 집계 연결을 확인하지 못했습니다." });
function summaryProjection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const counts = ["companyCount", "observedCompanies", "coveredCompanyDays", "expectedCompanyDays", "missingCompanyDays"];
  if (counts.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)
    || value.observedCompanies > value.companyCount || value.coveredCompanyDays > value.expectedCompanyDays
    || value.missingCompanyDays !== value.expectedCompanyDays - value.coveredCompanyDays
    || typeof value.coverageRate !== "number" || !Number.isFinite(value.coverageRate) || value.coverageRate < 0 || value.coverageRate > 1
    || (value.reservationRate != null && (typeof value.reservationRate !== "number" || !Number.isFinite(value.reservationRate) || value.reservationRate < 0 || value.reservationRate > 1))) return null;
  const result = Object.fromEntries(SUMMARY_KEYS.map(key => [key, typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0 ? value[key] : null]));
  result.availability = ["missing", "partial", "observed"].includes(value.availability) ? value.availability : "missing";
  result.revenuePartial = Boolean(value.revenuePartial);
  result.metricBasis = text(value.metricBasis);
  return result;
}
function createMonthlyReportIndustryContext({ industryService, now = () => new Date() } = {}) {
  return async function readIndustryContext(request, roster = {}, options = {}) {
    const month = request.month, end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10);
    const cutoffDate = request.cutoffDate < end ? request.cutoffDate : end;
    const asOfAt = new Date(options.asOfAt || now()).toISOString();
    const regions = new Map((roster.regions || []).filter(r => r.level === "local").map(r => [r.id, r]));
    const companies = [...new Map((roster.companies || []).filter(c => c.companyId && (request.type !== "company" || c.companyId === request.targetId)).map(c => [c.companyId, c])).values()];
    const pairs = new Map(); let unmappedCompanyCount = 0, unclassifiedCompanyCount = 0;
    for (const company of companies) {
      const region = company.industryRegionKey;
      if (!region || !regions.has(region)) { unmappedCompanyCount++; continue; }
      const industries = (company.industryIds || []).filter(id => IDS.has(id) && (!request.industry || request.industry === id));
      if (!industries.length && !request.industry) unclassifiedCompanyCount++;
      for (const industry of industries) pairs.set(`${region}:${industry}`, { industry, region });
    }
    if (request.industry && regions.has(request.targetId)) pairs.set(`${request.targetId}:${request.industry}`, { industry: request.industry, region: request.targetId });
    const targets = [...pairs.values()].sort((a,b) => a.region.localeCompare(b.region) || a.industry.localeCompare(b.industry));
    const warnings = ["업종 참고 집계는 월중 네이버 플레이스 1~20위 관측 업체의 표본입니다. 보고서 본문의 대상 업체군과 다를 수 있으며, 지역 전체 시장의 합계가 아닙니다.",
      "업종 예약률은 업체별 비율을 같은 비중으로 평균합니다. 본문의 공급량을 반영한 예약률과 같지 않으며 수량·매출을 본문에 더하지 않습니다.",
      "복합시설은 해당 업종에 각각 포함되므로 업종별 합계를 다시 더하지 않습니다."];
    if (cutoffDate !== request.cutoffDate) warnings.push(`마감월 업종 집계의 유효 관측 마감일은 월말 ${cutoffDate}입니다. 보고서 입력 마감일 ${request.cutoffDate}와 구별합니다.`);
    if (unmappedCompanyCount) warnings.push(`관측 업체 ${unmappedCompanyCount}곳은 업종 기준 실제 소재지를 확인하지 못해 연결하지 않았습니다.`);
    if (unclassifiedCompanyCount) warnings.push(`관측 업체 ${unclassifiedCompanyCount}곳은 저장 업종을 확인하지 못해 연결하지 않았습니다.`);
    if (targets.length > MAX_ENTRIES) warnings.push(`참고 집계 ${targets.length}개 중 ${MAX_ENTRIES}개를 연결했습니다. 나머지는 지역별 리포트에서 확인해 주세요.`);
    if (!targets.length) warnings.push("연결할 실제 지역·업종을 확인하지 못했습니다. 검색어의 지명으로 대체하지 않습니다.");
    const entries = [], sourceCheckGroup = {};
    for (const target of targets.slice(0, MAX_ENTRIES)) {
      const condition = { ...target, month, cutoffDate };
      const entry = { request: condition, industry: { id: target.industry, label: IDS.get(target.industry) }, regionLabel: regions.get(target.region)?.label || target.region,
        status: "missing", reasonCode: "NO_SAVED_INDUSTRY_AGGREGATE", reasonLabel: reasons.NO_SAVED_INDUSTRY_AGGREGATE, summary: null, storage: null,
        cohort: { minRank: 1, maxRank: 20, label: "기간 중 네이버 플레이스 1~20위 관측 업체" }, definitions: {}, warnings: [] };
      try {
        if (typeof industryService?.readSaved !== "function") throw Object.assign(new Error(), { code: "INDUSTRY_SERVICE_UNAVAILABLE" });
        const result = await industryService.readSaved(condition, { sourceCheckGroup });
        if (result?.networkAttempted === true) throw Object.assign(new Error(), { code: "MONTHLY_INDUSTRY_MUST_BE_SAVED_ONLY" });
        const storage = result?.storage || {};
        const same = result?.request && Object.keys(condition).every(k => result.request[k] === condition[k]);
        const provenance = storage.key && storage.resultVersion && storage.calculationVersion && storage.calculatedAt && storage.resultRevision;
        const validTime = typeof storage.calculatedAt === "string" && Number.isFinite(Date.parse(storage.calculatedAt)) && Date.parse(storage.calculatedAt) <= Date.parse(asOfAt);
        entry.storage = Object.fromEntries(STORAGE_KEYS.filter(k => Object.hasOwn(storage, k)).map(k => [k, ["boolean", "number"].includes(typeof storage[k]) ? storage[k] : text(storage[k])]));
        const status = storage.status === "pending" ? "missing" : STATUSES.has(storage.status) ? storage.status : "unavailable";
        if (storage.hasSnapshot && (!same || !provenance || !validTime || ["missing", "unavailable"].includes(status) || result.cohort?.minRank !== 1 || result.cohort?.maxRank !== 20)) {
          entry.status = "unavailable"; entry.reasonCode = "INDUSTRY_AGGREGATE_INVALID";
        } else if (storage.hasSnapshot && same) {
          entry.summary = summaryProjection(result.summary);
          entry.status = status === "ready" && storage.stale ? "stale" : status;
          entry.reasonCode = entry.status === "ready" ? "" : ["queued", "processing"].includes(entry.status) ? "INDUSTRY_AGGREGATE_PENDING"
            : entry.status === "failed" ? "INDUSTRY_AGGREGATE_FAILED" : "INDUSTRY_AGGREGATE_STALE";
          entry.definitions = Object.fromEntries(Object.entries(result.definitions || {}).slice(0, 16).map(([k,v]) => [text(k,80),text(v,1000)]));
          entry.warnings = (result.quality?.warnings || []).slice(0, 15).map(v => text(v,500));
          const companies = Array.isArray(result.companies) ? result.companies : [];
          const hasCapacity = company => typeof company.capacity === "number" && Number.isFinite(company.capacity) && company.capacity > 0;
          const reviewed = companies.filter(company => hasCapacity(company) && (["manual", "verified", "db_review"].includes(company.capacityBasis?.source)
            || /관리자.*검수|DB.*검토/.test(company.capacitySource || ""))).length;
          const unknown = companies.filter(company => !hasCapacity(company)).length;
          entry.capacityBasis = { policy: "관리자 검수값 우선, 없으면 고정 최대 관측값", companyCount: companies.length,
            reviewedCompanyCount: reviewed, unreviewedCompanyCount: Math.max(0, companies.length - reviewed - unknown), missingCapacityCompanyCount: unknown };
          if (!entry.summary) { entry.status = "unavailable"; entry.reasonCode = "INDUSTRY_AGGREGATE_INVALID"; }
        } else {
          entry.status = status === "ready" ? "missing" : status;
          entry.reasonCode = entry.status === "unavailable" ? /RESULT_(INVALID|SCHEMA_INVALID)/.test(storage.errorCode || "") ? "INDUSTRY_AGGREGATE_INVALID" : "INDUSTRY_AGGREGATE_READ_FAILED"
            : ["queued", "processing"].includes(entry.status) ? "INDUSTRY_AGGREGATE_PENDING" : entry.status === "failed" ? "INDUSTRY_AGGREGATE_FAILED" : "NO_SAVED_INDUSTRY_AGGREGATE";
        }
      } catch (error) {
        if (error.code === "MONTHLY_INDUSTRY_MUST_BE_SAVED_ONLY") throw error;
        entry.status = "unavailable"; entry.reasonCode = error.code === "INDUSTRY_SERVICE_UNAVAILABLE" ? error.code : "INDUSTRY_AGGREGATE_READ_FAILED";
      }
      entry.reasonLabel = reasons[entry.reasonCode] || "";
      entries.push(entry);
    }
    const allReady = entries.length > 0 && entries.every(e => e.status === "ready") && !unmappedCompanyCount && !unclassifiedCompanyCount && targets.length <= MAX_ENTRIES;
    return { schemaVersion: 1, month, cutoffDate, reportCutoffDate: request.cutoffDate, asOfAt, networkAttempted: false,
      status: allReady ? "ready" : entries.some(e => e.summary) ? "partial" : "missing", entries, warnings,
      selectionCoverage: { selectedEntryCount: targets.length, includedEntryCount: entries.length, omittedEntryCount: Math.max(0, targets.length - entries.length), unmappedCompanyCount, unclassifiedCompanyCount } };
  };
}
module.exports = { createMonthlyReportIndustryContext, MAX_ENTRIES };
