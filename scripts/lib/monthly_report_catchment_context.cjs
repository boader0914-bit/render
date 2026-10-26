"use strict";

// Saved regional background plus separately bound address-radius evidence.
// No grid, calculator, queue or provider is called when building a report.
const { validateCatchmentResult, normalizeAddress, addressFingerprint } = require("./regional_catchment.cjs");
const SCHEMA_VERSION = 2, MAX_REGIONS = 24, MAX_ENTRY_BYTES = 32768;
const ID = /^[A-Za-z0-9_:-]{1,120}$/;
const REASONS = Object.freeze({
  CATCHMENT_SERVICE_UNAVAILABLE: "반경 배후시장 저장 조회가 연결되지 않았습니다.",
  CATCHMENT_CENTER_NOT_CONFIGURED: "확인된 반경 기준점이 설정되지 않았습니다.",
  CATCHMENT_ADDRESS_REQUIRED: "확정된 상세 주소와 같은 위치의 좌표 근거가 필요합니다. 지역 중심점으로 대체하지 않습니다.",
  CATCHMENT_ADDRESS_AMBIGUOUS: "서로 다른 주소가 남아 있어 기준 주소를 확정하지 못했습니다.",
  CATCHMENT_ADDRESS_MISMATCH: "현재 업체 주소와 저장 기준점의 주소·업체가 달라 연결하지 않았습니다.",
  NO_SAVED_CATCHMENT: "같은 지역·기준점·자료의 저장 배후시장 결과가 없습니다.",
  CATCHMENT_READ_FAILED: "반경 배후시장 저장 자료를 읽지 못했습니다.",
  CATCHMENT_RESULT_INVALID: "저장 배후시장 결과의 조건·수치·근거를 확인해야 합니다.",
  CATCHMENT_AFTER_AS_OF: "리포트 작성시점 이후의 산출물이어서 연결하지 않았습니다.",
  CATCHMENT_REGION_UNSUPPORTED: "시군구 단위의 실제 지역만 연결하며 다른 지역으로 대체하지 않습니다.",
  CATCHMENT_PARTIAL: "공개 부분합과 보호·누락 상태를 함께 표시하며 전체 반경값은 미확정일 수 있습니다.",
  CATCHMENT_STALE: "마지막 정상 저장본이며 최근 갱신·저장 상태를 함께 확인해야 합니다.",
  CATCHMENT_CALCULATION_FAILED: "반경 배후시장 계산이 실패하거나 중단되어 정상 결과를 확인하지 못했습니다."
});
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const text = (x, max = 300) => typeof x === "string" ? x.replace(/[\x00-\x1f\x7f]/g, "").slice(0, max) : "";
const safeCode = x => typeof x === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(x) ? x : null;
function instant(value) {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value), day = new Date(value.slice(0, 10) + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value.slice(0, 10) ? date.toISOString() : null;
}
function date(value) { return typeof value === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(value) && instant(value + "T00:00:00Z")?.slice(0, 10) === value; }
function latestCompletedMonthAt(asOfAt) {
  const kst = new Date(Date.parse(asOfAt) + 32400000);
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}
function detachedResult(value) {
  // The existing result validator checks identities, provenance, geometry,
  // 3 bands x 3 metrics and arithmetic. Bound optional strings/notes as well.
  let nodes = 0;
  function visit(x, depth) {
    if (++nodes > 512 || depth > 10) throw Error("bounded_result");
    if (x === null || typeof x === "boolean") return;
    if (typeof x === "number" && Number.isFinite(x)) return;
    if (typeof x === "string" && x.length <= 2048) return;
    if (!x || typeof x !== "object") throw Error("non_json_result");
    const keys = Object.keys(x); if (keys.length > 64) throw Error("bounded_keys");
    for (const key of keys) { if (key.length > 100) throw Error("bounded_key"); visit(x[key], depth + 1); }
  }
  if (!Array.isArray(value?.notes) || value.notes.length > 12) throw Error("bounded_notes");
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_ENTRY_BYTES) throw Error("bounded_result_bytes");
  return JSON.parse(serialized);
}
function selection(request, roster) {
  const companies = (Array.isArray(roster.companies) ? roster.companies : []).filter(c => object(c) && (request.type !== "company" || c.companyId === request.targetId));
  const regions = new Map((Array.isArray(roster.regions) ? roster.regions : []).filter(object).map(r => [r.id, r]));
  const basis = request.type === "region" ? "selected_region_address" : request.type === "company" ? "company_actual_address" : "observed_companies_actual_addresses";
  const identities = request.type === "region" ? [{ regionKey: request.targetId }] : [...new Map(companies.filter(c => typeof c.companyId === "string" && ID.test(c.companyId)).map(c => [c.companyId, c])).values()];
  const selected = identities.filter(c => typeof c.regionKey === "string" && ID.test(c.regionKey)).sort((a, b) => `${a.regionKey}:${a.companyId || ""}`.localeCompare(`${b.regionKey}:${b.companyId || ""}`)).map(company => {
    const regionKey = company.regionKey;
    const region = regions.get(regionKey);
    let address = null;
    if (company.addressBasis?.status === "ready") { try { address = normalizeAddress(company.addressBasis.address); } catch {} }
    return { regionKey, regionLabel: text(region?.label || company.regionLabel || regionKey), selectionBasis: basis,
      ...(request.type === "region" ? {} : { companyId: company.companyId, companyLabel: text(company.primaryName || company.companyId), address,
        addressStatus: address ? "ready" : company.addressBasis?.status === "ambiguous" ? "ambiguous" : "missing" }),
      supported: !region || (region.level === "local" && region.active !== false && region.selectable !== false && region.unitType !== "general_district") };
  });
  const unmappedCompanyCount = request.type === "region" ? 0 : new Set(companies.filter(c => typeof c.regionKey !== "string" || !ID.test(c.regionKey)).map((c, i) => c.companyId || `unmapped_${i}`)).size;
  return { selected, unmappedCompanyCount };
}
function createMonthlyReportAddressContext({ catchmentService = null, now = () => new Date() } = {}) {
  return async function readCatchmentContext(request, roster = {}, options = {}) {
    if (!request || !["company", "keyword", "region"].includes(request.type) || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(request.month || "")
      || !date(request.cutoffDate)) throw new TypeError("A valid monthly report request is required");
    const currentAt = instant(new Date(now()).toISOString()), asOfAt = options.asOfAt === undefined ? currentAt : instant(options.asOfAt);
    const asOfDay = asOfAt && new Date(Date.parse(asOfAt) + 32400000).toISOString().slice(0, 10);
    if (!asOfAt || asOfAt > currentAt || request.cutoffDate > asOfDay) throw new TypeError("A valid report creation timestamp is required");
    const { selected, unmappedCompanyCount } = selection(request, roster), warnings = [
      "반경 배후시장은 저장된 연간 인구·사업체·종사자 참고 자료입니다. 보고월의 수요·고객 수·예약률로 환산하지 않습니다.",
      "업체의 확정 주소와 같은 위치로 대조한 좌표만 사용합니다. 지역 보고서는 명시한 기준 주소를 사용하며 업체 주소지와 혼동하지 않습니다.",
      "누적 100km에 두 구간을 다시 더하거나 지역 간 인구·종사자를 합쳐 고유 고객 수로 만들지 않습니다.",
      "자료 확인은 리포트 작성시점 기준이며 숙박 관측 마감일 당시 알려진 자료라는 뜻이 아닙니다."
    ];
    const result = { schemaVersion: 1, reportMonth: request.month, cutoffDate: request.cutoffDate, asOfAt,
      temporalBasis: "saved_annual_reference_at_report_creation", status: "missing", networkAttempted: false,
      selectionCoverage: { selectedRegionCount: new Set(selected.map(e => e.regionKey)).size,
        includedRegionCount: new Set(selected.slice(0, MAX_REGIONS).map(e => e.regionKey)).size,
        omittedRegionCount: new Set(selected.map(e => e.regionKey)).size - new Set(selected.slice(0, MAX_REGIONS).map(e => e.regionKey)).size,
        selectedAddressCount: selected.length, includedAddressCount: Math.min(selected.length, MAX_REGIONS), omittedAddressCount: Math.max(0, selected.length - MAX_REGIONS), unmappedCompanyCount }, entries: [], warnings };
    if (!selected.length) warnings.push("대상의 실제 소재지가 확인되지 않아 배후시장을 연결하지 않았습니다. 검색어의 지명으로 대체하지 않습니다.");
    if (unmappedCompanyCount) warnings.push(`관측 업체 ${unmappedCompanyCount}곳의 실제 소재지를 확인하지 못했습니다.`);
    if (selected.length > MAX_REGIONS) warnings.push(`주소 기준 대상 ${selected.length}개 중 ${MAX_REGIONS}개만 연결했습니다. 생략한 대상은 별도 확인이 필요합니다.`);
    for (const region of selected.slice(0, MAX_REGIONS)) {
      const { supported, ...identity } = region;
      const entry = { ...identity, status: "unavailable", reasonCode: "", reasonLabel: "", snapshot: null,
        storage: { lastReadSource: "stored_result", errorCode: null, jobStatus: null } };
      const unavailable = code => { entry.reasonCode = code; entry.reasonLabel = REASONS[code]; return entry; };
      if (!supported) { result.entries.push(unavailable("CATCHMENT_REGION_UNSUPPORTED")); continue; }
      if (region.companyId && !region.address) { entry.status = "missing"; result.entries.push(unavailable(region.addressStatus === "ambiguous" ? "CATCHMENT_ADDRESS_AMBIGUOUS" : "CATCHMENT_ADDRESS_REQUIRED")); continue; }
      if (typeof catchmentService?.get !== "function") { result.entries.push(unavailable("CATCHMENT_SERVICE_UNAVAILABLE")); continue; }
      try {
        const saved = await catchmentService.get({ regionKey: region.regionKey, ...(region.companyId ? { companyId: region.companyId, address: region.address } : {}) });
        if (saved?.networkAttempted === true || saved?.storage?.networkAttempted === true || saved?.snapshot?.networkAttempted === true) {
          throw Object.assign(Error("MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY"), { code: "MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY" });
        }
        if (saved?.storage?.networkAttempted !== false || saved?.scope?.regionKey !== region.regionKey
          || !["unqueried", "missing", "ready", "partial", "stale", "failed"].includes(saved?.status)) throw Error("invalid_saved_response");
        entry.storage.errorCode = safeCode(saved.storage.errorCode);
        entry.storage.jobStatus = ["queued", "running", "completed", "failed", "superseded", "interrupted"].includes(saved.job?.status) ? saved.job.status : null;
        if (!saved.snapshot) {
          if (!["unqueried", "missing", "failed"].includes(saved.status)) throw Error("missing_snapshot");
          entry.status = saved.status;
          unavailable(["CATCHMENT_ADDRESS_MISMATCH", "CATCHMENT_COMPANY_ADDRESS_REQUIRED", "CATCHMENT_ADDRESS_REQUIRED"].includes(entry.storage.errorCode)
            ? entry.storage.errorCode === "CATCHMENT_ADDRESS_MISMATCH" ? "CATCHMENT_ADDRESS_MISMATCH" : "CATCHMENT_ADDRESS_REQUIRED"
            : saved.status === "unqueried" ? "CATCHMENT_CENTER_NOT_CONFIGURED" : saved.status === "failed" ? "CATCHMENT_CALCULATION_FAILED" : "NO_SAVED_CATCHMENT");
        } else {
          const snapshot = saved.snapshot, config = saved.configuration;
          if (!config || config.regionKey !== region.regionKey || config.inputFingerprint !== snapshot.sourceFingerprint || config.datasetId !== snapshot.dataset?.id
            || !instant(snapshot.calculatedAt) || ![snapshot.status, "stale"].includes(saved.status)) throw Error("invalid_saved_binding");
          if (instant(snapshot.calculatedAt) > asOfAt) { result.entries.push(unavailable("CATCHMENT_AFTER_AS_OF")); continue; }
          validateCatchmentResult(snapshot, { regionKey: region.regionKey, center: config.center, datasetFingerprint: snapshot.dataset.fingerprint });
          if (!snapshot.scope.center.address || snapshot.scope.center.kind !== "address_reference_point") { result.entries.push(unavailable("CATCHMENT_ADDRESS_REQUIRED")); continue; }
          if (snapshot.scope.center.addressFingerprint !== addressFingerprint(snapshot.scope.center.address)
            || region.companyId && (snapshot.scope.companyId !== region.companyId || config.companyId !== region.companyId || saved.scope.companyId !== region.companyId
              || snapshot.scope.center.companyId !== region.companyId || normalizeAddress(snapshot.scope.center.address) !== region.address)
            || !region.companyId && (snapshot.scope.companyId || snapshot.scope.center.companyId || config.companyId)) {
            result.entries.push(unavailable("CATCHMENT_ADDRESS_MISMATCH")); continue;
          }
          if (snapshot.dataset.sourceYear > Number(asOfDay.slice(0, 4)) || snapshot.dataset.boundaryYear > Number(asOfDay.slice(0, 4))) throw Error("future_source_year");
          entry.snapshot = detachedResult(snapshot); entry.status = saved.status;
          if (entry.storage.errorCode || ["failed", "interrupted"].includes(entry.storage.jobStatus)) entry.status = "stale";
          if (entry.status !== "ready") unavailable(entry.status === "stale" ? "CATCHMENT_STALE" : entry.status === "partial" ? "CATCHMENT_PARTIAL" : "NO_SAVED_CATCHMENT");
        }
      } catch (error) {
        if (error?.code === "MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY") throw error;
        entry.status = "unavailable"; entry.snapshot = null;
        unavailable(error?.code === "CATCHMENT_INVALID_REGION" ? "CATCHMENT_REGION_UNSUPPORTED" : error?.code === "CATCHMENT_RESULT_INVALID" || /^invalid_|^bounded_|^non_json_|^future_/.test(error?.message || "") ? "CATCHMENT_RESULT_INVALID" : "CATCHMENT_READ_FAILED");
      }
      result.entries.push(entry);
    }
    result.status = result.entries.length && result.entries.every(e => e.status === "ready") ? "ready"
      : result.entries.some(e => e.snapshot && ["ready", "partial", "stale"].includes(e.status)) ? "partial"
        : result.entries.some(e => ["unavailable", "failed"].includes(e.status)) ? "unavailable" : "missing";
    if (result.status === "ready" && (unmappedCompanyCount || selected.length > MAX_REGIONS)) result.status = "partial";
    return result;
  };
}

function regionSelection(request, roster) {
  // Service rosters carry two independent locations. An explicitly missing
  // administrative region must never fall back to a resolved precise address.
  const administrativeKey = company => Object.hasOwn(company, "savedAdministrativeRegionKey") ? company.savedAdministrativeRegionKey : company.regionKey;
  const administrativeLabel = company => Object.hasOwn(company, "savedAdministrativeRegionLabel") ? company.savedAdministrativeRegionLabel : company.regionLabel;
  const regions = new Map((Array.isArray(roster.regions) ? roster.regions : []).filter(object).map(region => [region.id, region]));
  const companies = (Array.isArray(roster.companies) ? roster.companies : []).filter(company => object(company)
    && typeof company.companyId === "string" && ID.test(company.companyId)
    && (request.type !== "company" || company.companyId === request.targetId));
  const groups = new Map(), unmapped = new Set(), seen = new Map();
  for (const company of companies) {
    const regionKey = administrativeKey(company);
    if (seen.has(company.companyId) && seen.get(company.companyId) !== regionKey) {
      unmapped.add(company.companyId);
    } else seen.set(company.companyId, regionKey);
  }
  if (request.type === "region") {
    if (typeof request.targetId === "string" && ID.test(request.targetId)) groups.set(request.targetId, new Set());
  }
  else for (const [companyId, regionKey] of seen) {
    if (unmapped.has(companyId) || typeof regionKey !== "string" || !ID.test(regionKey)) { unmapped.add(companyId); continue; }
    if (!groups.has(regionKey)) groups.set(regionKey, new Set());
    groups.get(regionKey).add(companyId);
  }
  const selected = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([regionKey, ids]) => {
    const region = regions.get(regionKey), company = companies.find(value => administrativeKey(value) === regionKey);
    return { mode: "administrative_region", originKind: "administrative_region", regionKey,
      regionLabel: text(region?.label || (company && administrativeLabel(company)) || regionKey), companyIds: [...ids].sort(),
      selectionBasis: request.type === "region" ? "selected_region" : request.type === "company" ? "company_saved_region" : "observed_companies_saved_regions",
      supported: !region || (region.level === "local" && region.active !== false && region.selectable !== false && region.unitType !== "general_district") };
  });
  return { selected, unmappedCompanyCount: request.type === "region" ? 0 : unmapped.size };
}

function detachedRegionSnapshot(value) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_ENTRY_BYTES * 3) throw Error("bounded_region_result");
  return JSON.parse(serialized);
}

function createMonthlyReportCatchmentContext({ regionMarketService = null, catchmentService = null, now = () => new Date(), mode = "administrative_region" } = {}) {
  const readAddressContext = createMonthlyReportAddressContext({ catchmentService, now });
  if (mode === "address_radius") return readAddressContext;
  if (mode !== "administrative_region") throw new TypeError("Unsupported monthly catchment mode");
  return async function readCatchmentContext(request, roster = {}, options = {}) {
    // Preserve the strict request/as-of contract and separately retain only
    // verified, saved address results. An address is never required for a region.
    const precise = await readAddressContext(request, roster, options);
    const latestCompletedMonth = latestCompletedMonthAt(precise.asOfAt);
    const referenceMonth = request.month < latestCompletedMonth ? request.month : latestCompletedMonth;
    const { selected, unmappedCompanyCount } = regionSelection(request, roster);
    const included = selected.slice(0, MAX_REGIONS);
    const result = { schemaVersion: SCHEMA_VERSION, defaultMode: "administrative_region", reportMonth: request.month,
      cutoffDate: request.cutoffDate, asOfAt: precise.asOfAt, temporalBasis: "saved_regional_reference_at_report_creation",
      referenceMonth, referenceBasis: "min_report_month_latest_completed_month_at_creation_kst",
      status: "missing", networkAttempted: false,
      selectionCoverage: { selectedRegionCount: selected.length, includedRegionCount: included.length,
        omittedRegionCount: selected.length - included.length, unmappedCompanyCount },
      entries: [], preciseEntries: precise.entries.filter(entry => entry.snapshot).map(entry => ({
        ...entry, mode: "address_radius", originKind: "address_reference_point" })),
      preciseCoverage: precise.selectionCoverage, preciseStatus: precise.status,
      warnings: [
        "기본 배후시장은 업체의 저장 소재지에 연결한 시군구 공식 지역 통계입니다. 업체 주소의 반경 수치가 아닙니다.",
        "같은 지역은 한 번만 연결하며 여러 지역의 인구·가구·사업체·종사자를 합쳐 고유 고객 수로 만들지 않습니다.",
        "지표의 기준기간과 저장 확인시점을 구분하며 보고월의 관광 수요·예약·매출로 환산하지 않습니다.",
        `지역 저장분석 참조월은 ${referenceMonth}입니다. 보고 대상월과 작성시점의 한국시간 마지막 마감월 중 이른 달이며 지표별 실제 공표기간은 별도입니다.`,
        "방문객 출발지·이동권은 미확보이며 인구나 지역 통계로 추정하지 않습니다.",
        "주소 반경 정밀 근거가 따로 저장된 경우에만 별도 표시합니다. 지역 통계를 주소 정밀 결과로 바꾸지 않습니다."
      ] };
    if (!selected.length) result.warnings.push("대상의 저장 소재지가 확인되지 않아 지역 배후시장을 연결하지 않았습니다. 검색어 지명으로 대체하지 않습니다.");
    if (unmappedCompanyCount) result.warnings.push(`관측 업체 ${unmappedCompanyCount}곳의 저장 소재지를 확정하지 못했습니다.`);
    if (selected.length > MAX_REGIONS) result.warnings.push(`지역 ${selected.length}개 중 ${MAX_REGIONS}개만 연결했습니다. 생략 지역은 별도 확인이 필요합니다.`);
    for (const selectedRegion of included) {
      const { supported, ...identity } = selectedRegion;
      const entry = { ...identity, referenceMonth, status: "missing", reasonCode: "", reasonLabel: "", regionSnapshot: null };
      const unavailable = (code, label) => { entry.status = "unavailable"; entry.reasonCode = code; entry.reasonLabel = label; };
      if (!supported) unavailable("CATCHMENT_REGION_UNSUPPORTED", REASONS.CATCHMENT_REGION_UNSUPPORTED);
      else if (typeof regionMarketService?.get !== "function") unavailable("REGION_MARKET_SERVICE_UNAVAILABLE", "시군구 저장 지역 통계 조회가 연결되지 않았습니다.");
      else try {
        const saved = await regionMarketService.get({ regionKey: entry.regionKey, month: referenceMonth, months: 13 });
        if (saved?.networkAttempted === true) throw Object.assign(Error("MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY"), { code: "MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY" });
        if (saved?.networkAttempted !== false || saved.mode !== "administrative_region" || saved.originKind !== "administrative_region"
          || saved.scope?.regionKey !== entry.regionKey || saved.scope?.month !== referenceMonth
          || !["ready", "partial", "missing", "needs_verification"].includes(saved.status)) throw Error("invalid_region_binding");
        for (const stamp of [saved.generatedAt, saved.calculatedAt, saved.retrievedAt, saved.source?.generatedAt, saved.source?.calculatedAt,
          ...(saved.metrics || []).map(metric => metric.source?.retrievedAt)].filter(Boolean)) {
          if (!instant(stamp) || instant(stamp) > result.asOfAt) throw Error("future_region_evidence");
        }
        const { validateRegionalMarketSnapshot } = require("./regional_market.cjs");
        validateRegionalMarketSnapshot(saved, { regionKey: entry.regionKey, month: referenceMonth, asOfAt: result.asOfAt });
        entry.regionSnapshot = detachedRegionSnapshot(saved); entry.status = saved.status;
        if (saved.status !== "ready") {
          entry.reasonCode = saved.status === "needs_verification" ? "REGION_MARKET_NEEDS_VERIFICATION" : saved.status === "partial" ? "REGION_MARKET_PARTIAL" : "REGION_MARKET_MISSING";
          entry.reasonLabel = saved.status === "needs_verification" ? "지역·기간·원문 근거를 확인하지 못한 지표는 미확인으로 유지합니다."
            : saved.status === "partial" ? "확인된 지표와 미확인 지표를 함께 표시합니다." : "사용할 저장 지역 통계가 없습니다. 0으로 계산하지 않습니다.";
        }
      } catch (error) {
        if (error?.code === "MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY") throw error;
        unavailable(error?.message === "future_region_evidence" ? "REGION_MARKET_AFTER_AS_OF" : "REGION_MARKET_READ_FAILED",
          error?.message === "future_region_evidence" ? "보고서 작성시점 이후 근거여서 연결하지 않았습니다." : "저장 지역 통계의 지역·기간·출처를 확인하지 못했습니다.");
      }
      result.entries.push(entry);
    }
    result.status = result.entries.length && result.entries.every(entry => entry.status === "ready") ? "ready"
      : result.entries.some(entry => ["ready", "partial"].includes(entry.status)) ? "partial"
        : result.entries.some(entry => entry.status === "needs_verification") ? "needs_verification"
          : result.entries.some(entry => entry.status === "unavailable") ? "unavailable" : "missing";
    if (result.status === "ready" && (unmappedCompanyCount || selected.length > MAX_REGIONS)) result.status = "partial";
    return result;
  };
}
module.exports = { createMonthlyReportCatchmentContext, createMonthlyReportAddressContext, SCHEMA_VERSION, MAX_REGIONS, MAX_ENTRY_BYTES };
