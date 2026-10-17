(function (root) {
  "use strict";

  // Shared policy only: callers supply saved provenance. This module never
  // collects data, guesses a response's geography, or aggregates child areas.
  const VERSION = "regional-data-contract-v1";
  const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
  const text = value => typeof value === "string" ? value.trim() : "";
  const code = value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : text(value);
  const numeric = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const levelOf = value => ["local", "sigungu", "기초지자체", "시군구", "시·군·구"].includes(value) ? "sigungu"
    : ["broad", "sido", "광역지자체", "시도", "시·도"].includes(value) ? "sido" : "unknown";
  const periodTypeOf = value => ["M", "monthly"].includes(value) ? "M" : ["Y", "A", "annual", "yearly"].includes(value) ? "Y" : "";
  const unique = values => [...new Set(values.filter(Boolean))];
  const ktoProvider = provider => /한국관광공사|\bkto\b/i.test(provider);
  function regionCodeOf(value, level) {
    return code(value?.providerRegionCode) || code(value?.regionCode) || code(value?.areaCode)
      || (level === "sido" ? code(value?.ktoSidoCd) : code(value?.signguCode) || code(value?.signguCd) || code(value?.ktoSggCd));
  }
  // Only bounded, non-secret audit fields may travel with a saved observation.
  // This describes a verifier's result; it never verifies a raw file itself.
  function storedProvenanceOf(value) {
    if (!value || value.sourceKind !== "stored_raw_response" || !/^[a-f0-9]{64}$/.test(value.sha256 || "")
      || !/^[a-zA-Z0-9_-]{1,120}$/.test(value.evidenceId || "") || !MONTH.test(value.period || "")
      || !/^[a-z0-9-]{1,100}$/.test(value.version || "")) return null;
    return { version: value.version, sourceKind: "stored_raw_response", evidenceId: value.evidenceId, sha256: value.sha256,
      period: value.period, verifiedAt: Number.isFinite(Date.parse(value.verifiedAt)) ? new Date(value.verifiedAt).toISOString() : "",
      checks: unique((Array.isArray(value.checks) ? value.checks : []).filter(check => typeof check === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(check))).slice(0, 16) };
  }
  function storedEvidenceSummary(contract, verification) {
    const provenance = contract?.status === "matched" && contract.evidence === "response" ? storedProvenanceOf(contract.storedProvenance) : null;
    if (provenance) return { label: "보관 원본 재검증", reason: "지역·기간·수량 일치 확인", ...provenance };
    if (!verification || !["pending", "rejected"].includes(verification.status)) return null;
    return { label: verification.status === "rejected" ? "보관 원본 검증 불일치" : "보관 근거 미확인",
      reason: /NOT_(STORED|RETAINED)|MISSING|NOT_FOUND/.test(verification.reasonCode || "") ? "응답 원본이 없어 범위를 확인할 수 없습니다."
        : "보관 근거로 지역·기간·수량의 일치를 확인하지 못했습니다." };
  }
  function createSpatialContract({ region = {}, provider = "", sourceRegion = null, evidence = null, scopeKind = "administrative" } = {}) {
    const requestedRegionKey = text(region.regionKey) || text(region.regionId);
    const requestedLevel = levelOf(region.level || region.unit);
    const officialCode = code(region.officialCode);
    const normalizedScope = scopeKind === "keyword" ? "keyword" : "administrative";
    const providedLevels = unique([sourceRegion?.providedLevel, sourceRegion?.level, sourceRegion?.unit, evidence?.level].map(levelOf).filter(value => value !== "unknown"));
    const providedLevel = providedLevels[0] || "unknown";
    const providerName = text(provider);
    const mapping = ktoProvider(providerName) ? region.providerMappings?.kto : null;
    const requestedProviderCodes = ktoProvider(providerName) ? unique([regionCodeOf(mapping, requestedLevel), regionCodeOf(region, requestedLevel),
      /^\d{10}$/.test(officialCode) ? officialCode.slice(0, requestedLevel === "sido" ? 2 : 5) : ""]) : [];
    const requestedProviderCode = requestedProviderCodes[0] || "";
    const providerRegionCode = regionCodeOf(sourceRegion, requestedLevel) || code(evidence?.regionCode) || requestedProviderCode;
    const result = { version: VERSION, requestedRegionKey, officialCode, requestedLevel, requestedUnitType: text(region.unitType) || "unknown",
      provider: providerName, providerRegionCode, providedLevel, scopeKind: normalizedScope, status: "scope_unverified", evidence: "unverified", aggregation: "none", reasonCode: "SCOPE_UNVERIFIED" };
    const finish = (status, reasonCode) => ({ ...result, status, reasonCode });
    if (region.active === false || region.selectable === false || region.unitType === "general_district") return finish("scope_unverified", "REGION_NOT_SELECTABLE");
    if (!requestedRegionKey || !["administrative", "keyword"].includes(scopeKind)) return finish("scope_unverified", "SCOPE_UNVERIFIED");
    if (normalizedScope === "keyword") {
      if (text(sourceRegion?.regionKey) && sourceRegion.regionKey !== requestedRegionKey || text(evidence?.regionKey) && evidence.regionKey !== requestedRegionKey) return finish("response_mismatch", "RESPONSE_REGION_MISMATCH");
      if (evidence?.verified === true && evidence.keywordVerified === true && evidence.regionKey === requestedRegionKey && sourceRegion?.regionKey === requestedRegionKey) {
        return { ...finish("matched", "SCOPE_MATCHED"), evidence: "keyword" };
      }
      return result;
    }
    const responseCodes = unique([sourceRegion?.providerRegionCode, sourceRegion?.regionCode, sourceRegion?.areaCode,
      ...(requestedLevel === "sido" ? [sourceRegion?.ktoSidoCd] : [sourceRegion?.signguCode, sourceRegion?.signguCd, sourceRegion?.ktoSggCd])].map(code));
    const observedRegionCodes = unique((Array.isArray(evidence?.observedRegionCodes) ? evidence.observedRegionCodes : []).map(code));
    const conflict = text(sourceRegion?.regionKey) && sourceRegion.regionKey !== requestedRegionKey
      || text(evidence?.regionKey) && evidence.regionKey !== requestedRegionKey
      || code(evidence?.regionCode) && evidence.regionCode.toString().trim() !== providerRegionCode
      || responseCodes.length > 1 || providedLevels.length > 1
      || providedLevel !== "unknown" && requestedLevel !== "unknown" && providedLevel !== requestedLevel
      || requestedProviderCodes.some(expected => providerRegionCode !== expected)
      || evidence?.reasonCode === "REGION_MISMATCH"
      || providerRegionCode && observedRegionCodes.some(observed => observed !== providerRegionCode);
    if (conflict) return { ...finish("response_mismatch", "RESPONSE_REGION_MISMATCH"), evidence: evidence?.verified === true ? "response" : "unverified" };
    if (evidence?.reasonCode === "INVALID_RESPONSE" || evidence?.storedProvenance && !storedProvenanceOf(evidence.storedProvenance)) return finish("scope_unverified", "INVALID_RESPONSE");
    // Collector diagnostics historically used "pending" for an unverified
    // response. Only explicit mapping metadata can establish a mapping state;
    // absent response codes and empty results leave scope unverified.
    const mappingStates = [sourceRegion?.mappingStatus, sourceRegion?.codeStatus, mapping?.status, mapping?.codeStatus, region.mappingStatus, region.codeStatus].map(text);
    if (mappingStates.some(value => /pending|verify/.test(value))) return finish("mapping_pending", "MAPPING_PENDING");
    if (mappingStates.some(value => ["missing", "mapping_missing", "unmapped", "not_found"].includes(value))) return finish("mapping_missing", "MAPPING_MISSING");
    if (providerRegionCode && evidence?.verified === true && evidence.regionKey === requestedRegionKey && code(evidence.regionCode) === providerRegionCode
      && requestedLevel !== "unknown" && levelOf(evidence.level) === requestedLevel && providedLevel === requestedLevel && officialCode) {
      const storedProvenance = storedProvenanceOf(evidence.storedProvenance);
      return { ...finish("matched", "SCOPE_MATCHED"), evidence: "response", ...(storedProvenance ? { storedProvenance } : {}) };
    }
    return result;
  }

  const REASONS = {
    SCOPE_MATCHED: "지역 범위·출처·단위·기간 일치", SCOPE_UNVERIFIED: "지역 범위 확인 필요", MAPPING_PENDING: "지역 코드 매핑 확인 대기",
    MAPPING_MISSING: "지역 코드 매핑 없음", RESPONSE_REGION_MISMATCH: "요청 지역과 응답 범위 다름", REGION_NOT_SELECTABLE: "직접 비교할 행정구역이 아님",
    KEYWORD_SCOPE: "검색어별 추이는 지역 간 직접 비교 불가", DUPLICATE_REGION: "같은 지역이 중복됨", PROVIDER_MISMATCH: "자료 출처 다름",
    PROVIDER_UNVERIFIED: "자료 출처 미확인", UNIT_MISMATCH: "단위 다름", UNIT_UNVERIFIED: "단위 미확인", PERIOD_TYPE_MISMATCH: "월간·연간 자료 혼합",
    PERIOD_TYPE_UNVERIFIED: "공표 주기 미확인", LEVEL_MISMATCH: "행정구역 단위 다름", METRIC_MISMATCH: "비교 지표 다름"
  };
  function comparisonEligibility(cells) {
    let periodType = "", providedLevel = "";
    const answer = reasonCode => ({ comparable: reasonCode === "SCOPE_MATCHED", reasonCode, reason: REASONS[reasonCode] || REASONS.SCOPE_UNVERIFIED, periodType, providedLevel });
    if (!Array.isArray(cells) || !cells.length || cells.some(cell => !cell?.group || !cell?.metric || !text(cell.regionKey))) return answer("SCOPE_UNVERIFIED");
    if (unique(cells.map(cell => cell.regionKey)).length !== cells.length) return answer("DUPLICATE_REGION");
    if (cells.some(({ group, metric }) => group.category === "search" || group.key === "searchTrend" || metric.spatialContract?.scopeKind === "keyword" || group.spatialContract?.scopeKind === "keyword")) return answer("KEYWORD_SCOPE");
    for (const { regionKey, group, metric } of cells) {
      const contract = metric.spatialContract || group.spatialContract;
      if (!contract || contract.version !== VERSION) return answer("SCOPE_UNVERIFIED");
      if (contract.requestedRegionKey !== regionKey) return answer("RESPONSE_REGION_MISMATCH");
      if (contract.status !== "matched") return answer(["mapping_pending", "mapping_missing", "response_mismatch"].includes(contract.status)
        ? ({ mapping_pending: "MAPPING_PENDING", mapping_missing: "MAPPING_MISSING", response_mismatch: "RESPONSE_REGION_MISMATCH" })[contract.status]
        : contract.reasonCode === "REGION_NOT_SELECTABLE" ? "REGION_NOT_SELECTABLE" : "SCOPE_UNVERIFIED");
      if (contract.scopeKind !== "administrative" || contract.evidence !== "response" || contract.aggregation !== "none"
        || !text(contract.officialCode) || !text(contract.providerRegionCode) || !["sigungu", "sido"].includes(contract.requestedLevel)
        || contract.requestedLevel !== contract.providedLevel || contract.requestedUnitType === "general_district") return answer("SCOPE_UNVERIFIED");
      if (text(contract.provider) !== text(group.provider)) return answer("PROVIDER_UNVERIFIED");
      if (metric.spatialContract && group.spatialContract) {
        const outer = group.spatialContract;
        if (outer.version !== VERSION) return answer("SCOPE_UNVERIFIED");
        if (outer.requestedRegionKey !== regionKey || outer.status === "response_mismatch") return answer("RESPONSE_REGION_MISMATCH");
        if (outer.status === "matched" && (outer.requestedLevel !== contract.requestedLevel || outer.providedLevel !== contract.providedLevel
          || outer.scopeKind !== contract.scopeKind || outer.provider !== contract.provider || outer.evidence !== "response" || outer.aggregation !== "none")) return answer("SCOPE_UNVERIFIED");
      }
    }
    const providers = unique(cells.map(cell => text(cell.group.provider)));
    if (cells.some(cell => !text(cell.group.provider))) return answer("PROVIDER_UNVERIFIED");
    if (providers.length !== 1) return answer("PROVIDER_MISMATCH");
    const units = unique(cells.map(cell => text(cell.metric.unit)));
    if (cells.some(cell => !text(cell.metric.unit))) return answer("UNIT_UNVERIFIED");
    if (units.length !== 1) return answer("UNIT_MISMATCH");
    const periods = cells.map(cell => periodTypeOf(cell.metric.periodType || cell.group.periodType));
    if (periods.some(value => !value)) return answer("PERIOD_TYPE_UNVERIFIED");
    if (unique(periods).length !== 1) return answer("PERIOD_TYPE_MISMATCH");
    periodType = periods[0];
    const levels = unique(cells.map(cell => (cell.metric.spatialContract || cell.group.spatialContract).providedLevel));
    if (levels.length !== 1) return answer("LEVEL_MISMATCH");
    providedLevel = levels[0];
    const contracts = cells.map(cell => cell.metric.spatialContract || cell.group.spatialContract);
    if (unique(contracts.map(contract => contract.providerRegionCode)).length !== cells.length
      || unique(contracts.map(contract => contract.officialCode)).length !== cells.length) return answer("RESPONSE_REGION_MISMATCH");
    if (unique(cells.map(cell => `${text(cell.group.key)}\u0000${text(cell.metric.key)}`)).length !== 1) return answer("METRIC_MISMATCH");
    return answer("SCOPE_MATCHED");
  }

  function availabilityOf(point) {
    const status = text(point?.status), reasonCode = text(point?.reasonCode) || text(point?.errorCode);
    const finish = (state, fallback) => ({ status: state, value: state === "observed" ? point.value : null, observed: state === "observed", reasonCode: state === "observed" ? "" : reasonCode || fallback });
    if (["failed", "error", "blocked", "interrupted"].includes(status)) return finish("error", "PROVIDER_FAILED");
    if (status === "publication_pending" || reasonCode === "PUBLICATION_PENDING" || ["period_not_closed", "publication_pending", "not_published"].includes(point?.reason)) return finish("publication_pending", "PUBLICATION_PENDING");
    if (status === "unsupported" || ["UNSUPPORTED", "PROVIDER_UNSUPPORTED"].includes(reasonCode)) return finish("unsupported", "PROVIDER_UNSUPPORTED");
    if (status === "suppressed") return finish("suppressed", "SUPPRESSED");
    if (status === "partial") return finish("partial", "PARTIAL_DATA");
    if (["observed", "ready", "complete", "completed", "available"].includes(status)) return numeric(point?.value) ? finish("observed", "") : finish("missing", "MISSING_VALUES");
    return finish("missing", "UNRECORDED_REASON");
  }
  function temporalPolicy({ month, months = 13, periodType = "M", scopeKind = "administrative" } = {}) {
    const normalizedPeriod = periodTypeOf(periodType);
    return { version: VERSION, periodType: normalizedPeriod, scopeKind: scopeKind === "keyword" ? "keyword" : "administrative",
      requestedThrough: MONTH.test(text(month)) ? text(month) : "", expectedMonths: normalizedPeriod === "M" ? (Number(months) >= 24 ? 24 : 13) : null,
      anchor: normalizedPeriod === "M" ? "latest_observed" : "actual_publication", annualSlicing: false };
  }

  const api = { VERSION, createSpatialContract, comparisonEligibility, availabilityOf, temporalPolicy, storedProvenanceOf, storedEvidenceSummary };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RegionalDataContract = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
