"use strict";

// All dependencies supplied here are cache-only readers. A report never refreshes
// a provider, starts a crawler, or turns annual statistics into monthly values.
function createMonthlyReportContext({ kosisService, tourismCollector }) {
  return async function readContext(request, catalog) {
    if (request.type === "keyword") {
      const regionIds = [...new Set(catalog.companies.map(company => company.regionKey).filter(Boolean))].sort();
      const sources = [], warnings = ["검색 키워드와 실제 소재지를 구분합니다. 아래 지역 통계는 관측 업체의 실제 소재지별 참고 자료이며 지역 간 합산하지 않습니다."];
      for (const regionId of regionIds) {
        const context = await readContext({ ...request, type: "region", targetId: regionId }, catalog);
        sources.push(...context.sources.map(source => ({ ...source, key: `${regionId}:${source.key}`, regionKey: regionId })));
        warnings.push(...context.warnings);
      }
      if (!regionIds.length) warnings.push("관측 업체의 실제 소재지를 확인하지 못해 지역 통계를 연결하지 않았습니다.");
      return { sources, warnings: [...new Set(warnings)], networkAttempted: false };
    }
    const regionId = request.type === "region" ? request.targetId
      : request.type === "company" ? catalog.companies.find(company => company.companyId === request.targetId)?.regionKey : "";
    const region = catalog.regions.find(item => item.id === regionId);
    const sources = [], warnings = [];
    if (!regionId) return { sources, warnings: ["키워드의 검색 범위와 실제 소재지는 다를 수 있어 지역 통계를 임의로 합산하지 않았습니다."], networkAttempted: false };
    const kosis = await kosisService.getRegion(regionId);
    if (kosis.networkAttempted) throw new Error("MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY");
    for (const dataset of kosis.datasets || []) sources.push({ key: `kosis_${dataset.key}`, label: dataset.label,
      provider: "KOSIS", regionLabel: region?.label || regionId, status: dataset.status,
      period: dataset.period || "", periodType: dataset.periodType, sourceUrl: dataset.sourceUrl || "",
      retrievedAt: dataset.retrievedAt || "", sourceUpdatedAt: dataset.sourceUpdatedAt || "",
      referenceOnly: true, rows: (dataset.rows || []).map(row => ({ key: row.key, label: row.label, value: row.value, unit: row.unit, status: row.status })) });
    if (!sources.length) warnings.push("이 지역의 저장된 KOSIS 통계가 없습니다.");
    if (region?.level !== "local") {
      warnings.push("관광 지표는 시군구 단위로 제공되며 광역 지표로 임의 합산하지 않았습니다.");
      return { sources, warnings, networkAttempted: false };
    }
    const yearMonth = request.month.replace("-", "");
    const input = { regionKeys: [regionId], regionKey: regionId, endYearMonth: yearMonth, months: 1, analysisMonths: 1,
      collectMissing: false, refresh: false, force: false, maxPagesPerOperation: 1 };
    const readers = [
      ["visitors", "지역 방문자", "collectVisitorHistory", [["averageDailyVisitors", "일평균 방문자", "명"], ["visitorDays", "월간 방문자 누계", "인일"]]],
      ["stay_spend", "체류·소비 지수", "collectDemandStrengthHistory", [["stayOverall", "체류 지수", "지수"], ["spendOverall", "소비 지수", "지수"]]],
      ["resource", "관광자원 수요 지수", "collectResourceDemandHistory", [["service", "서비스", "지수"], ["culture", "문화", "지수"]]],
      ["diversity", "관광 다양성 지수", "collectDiversityHistory", [["visitor", "관광객", "지수"], ["spend", "소비", "지수"], ["international", "국제", "지수"]]]
    ];
    for (const [key, label, method, metrics] of readers) {
      if (typeof tourismCollector[method] !== "function") continue;
      try {
        const result = await tourismCollector[method](input);
        if (Number(result.collection?.networkAttemptedMonths || result.collection?.operationCallsAttempted || 0)) throw new Error("MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY");
        const points = key === "visitors" ? result.regions?.find(item => item.regionKey === regionId)?.series : result.series;
        const point = (points || []).find(item => item.yearMonth === yearMonth);
        sources.push({ key: `tourism_${key}`, label, provider: "한국관광공사", regionLabel: region?.label || regionId,
          status: point?.status || "missing", period: yearMonth, periodType: "M", sourceUrl: result.source?.referenceUrl || "",
          retrievedAt: point?.collectedAt || "", referenceOnly: false,
          rows: metrics.map(([field, metricLabel, unit]) => {
            const value = ["resource", "diversity"].includes(key) ? point?.values?.[field] : point?.[field];
            const observed = point?.status === "complete" && Number.isFinite(value);
            return { key: field, label: metricLabel, value: observed ? value : null, unit, status: observed ? "observed" : "missing" };
          }) });
      } catch (error) {
        if (error.message === "MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY") throw error;
        sources.push({ key: `tourism_${key}`, label, provider: "한국관광공사", regionLabel: region?.label || regionId,
          period: yearMonth, periodType: "M", status: "missing", rows: [], referenceOnly: false });
      }
    }
    warnings.push("KOSIS는 저장된 공표기간의 참고 통계입니다. 리포트 대상 월의 값으로 환산하거나 인과관계로 해석하지 않습니다.");
    return { sources, warnings, networkAttempted: false };
  };
}

module.exports = { createMonthlyReportContext };
