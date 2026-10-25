"use strict";

// Saved annual background only. This adapter has no grid, calculator, queue or
// provider dependency. Publication must freeze its returned, detached evidence.
const { validateCatchmentResult, normalizeAddress, addressFingerprint } = require("./regional_catchment.cjs");
const SCHEMA_VERSION = 1, MAX_REGIONS = 24, MAX_ENTRY_BYTES = 32768;
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
function createMonthlyReportCatchmentContext({ catchmentService = null, now = () => new Date() } = {}) {
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
    const result = { schemaVersion: SCHEMA_VERSION, reportMonth: request.month, cutoffDate: request.cutoffDate, asOfAt,
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
module.exports = { createMonthlyReportCatchmentContext, SCHEMA_VERSION, MAX_REGIONS, MAX_ENTRY_BYTES };
