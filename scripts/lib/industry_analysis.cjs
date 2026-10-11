"use strict";

// Read-only view over saved evidence. Inventory validation and capacity review
// stay owned by the monthly-report pipeline; search rank is a separate cohort.
const { buildMonthlyReportSnapshot } = require("./monthly_reports.cjs");

const INDUSTRIES = [
  { id: "glamping", label: "글램핑", unitLabel: "객실/동", pattern: /글램핑/ },
  { id: "campground", label: "캠핑장", unitLabel: "사이트", pattern: /캠핑장|야영장|오토캠핑/ },
  { id: "caravan", label: "카라반", unitLabel: "카라반/객실", pattern: /카라반|캐러밴/ },
  { id: "pension", label: "펜션", unitLabel: "객실", pattern: /펜션|팬션/ },
  { id: "poolVilla", label: "풀빌라", unitLabel: "독채/객실", pattern: /풀빌라/ },
  { id: "privateStay", label: "독채숙소", unitLabel: "동/채", pattern: /독채|한옥/ },
  { id: "hotelResort", label: "호텔/리조트", unitLabel: "객실", pattern: /호텔|리조트/ },
  { id: "motel", label: "모텔", unitLabel: "객실", pattern: /모텔/ }
];
const CANDIDATES = ["포천시", "가평군", "홍천군", "양양군", "태안군", "제천시", "무주군", "여수시", "경주시", "청도군", "산청군", "사천시", "서귀포시"];
const COHORT = { minRank: 1, maxRank: 20, label: "기간 중 네이버 플레이스 1~20위 관측 업체", basis: "month_keyword_rank_union", representative: false };
const FEATURES = { scaleGroups: false, performanceTiers: false };
const DEFERRED_SCALE = { status: "deferred", basis: "industry_specific", description: "규모 구간은 업종별로 정의하며 구간 분류와 성과 등급은 보류합니다." };
const idOf = value => String(value?.companyId || value?.companyKey || value?.id || "");
const norm = value => String(value || "").normalize("NFKC").replace(/\s+/g, "");
const qualityOf = run => String(typeof run?.collectionQuality === "string" ? run.collectionQuality : run?.collectionQuality?.status || "unknown").toLowerCase();
const finite = value => typeof value === "number" && Number.isFinite(value);
const mean = values => { const known = values.filter(finite); return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null; };
const sum = (rows, key) => rows.length ? rows.reduce((total, row) => total + row[key], 0) : null;
const ratio = (n, d) => d > 0 ? n / d : null;
const dayOf = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return "";
  const stamp = Date.parse(value);
  const calendar = Date.parse(value.slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== value.slice(0, 10)) return "";
  return Number.isFinite(stamp) ? new Date(stamp + 9 * 3600000).toISOString().slice(0, 10) : "";
};
const fail = (code, message) => Object.assign(new Error(message), { code, statusCode: 400 });
const publicIndustry = ({ pattern, ...industry }) => industry;
const RANK_FIELDS = ["companyId", "companyKey", "id", "runId", "keyword", "rank", "overallRank", "collectedAt"];
const RUN_FIELDS = ["id", "runId", "keyword", "searchMode", "collectedAt", "collectedAtSource", "collectionQuality"];
const pick = (row, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));

function compactIndustrySources(source, catalog) {
  const localRegions = catalogRegions(catalog.regions);
  const companies = (source.companies || []).map(company => {
    const raw = catalog.rawCompanies.get(idOf(company)) || {};
    const region = actualRegion(raw, localRegions);
    return { ...pick(company, ["companyId", "companyKey", "id", "primaryName", "companyName", "name", "deletedAt", "mergedIntoCompanyId", "capacity", "capacityBasis", "capacitySource"]),
      lodgingTypes: raw.lodgingTypes || [], industryIds: raw.industryIds || [], regionKey: region?.id || "",
      regionKeys: region ? [region.id] : [], regionLabel: region?.label || "지역 확인 전" };
  });
  const compact = { ...pick(source, ["regions", "specialDays", "warnings", "sourceDiagnostics", "globalWarnings", "globalDiagnostics"]), companies,
    // Keep each observation unchanged: the common engine hashes the complete
    // original row to resolve equal-time observations and exact duplicates.
    // Large raw company inventories and unused run payloads are not retained.
    observations: source.observations || [],
    rankObservations: (source.rankObservations || []).map(row => pick(row, RANK_FIELDS)),
    runs: (source.runs || []).map(run => ({ ...pick(run, RUN_FIELDS), collectionQuality: { status: qualityOf(run) } })) };
  return { source: compact, catalog: { companies, regions: catalog.regions } };
}
function normalizeRequest(input = {}, now = new Date()) {
  const industry = ({ camping: "campground", poolvilla: "poolVilla" })[input.industry] || input.industry || "glamping";
  if (!INDUSTRIES.some(item => item.id === industry)) throw fail("invalid_industry", "업종을 확인해 주세요.");
  const month = String(input.month || "");
  if (!/^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/.test(month)) throw fail("invalid_month", "대상 월은 YYYY-MM 형식으로 선택해 주세요.");
  const today = new Date(new Date(now).getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const cutoffDate = input.cutoffDate || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDate) || !Number.isFinite(Date.parse(cutoffDate)) || new Date(cutoffDate).toISOString().slice(0, 10) !== cutoffDate || cutoffDate > today) throw fail("invalid_cutoff", "관측 기준일을 확인해 주세요.");
  const region = String(input.region || "all").trim();
  if (!region || region.length > 120 || /[\x00-\x1f]/.test(region)) throw fail("invalid_region", "지역을 확인해 주세요.");
  return { industry, month, region, cutoffDate };
}
function industryIds(company) {
  const explicit = Array.isArray(company.industryIds) ? company.industryIds.filter(id => INDUSTRIES.some(item => item.id === id)) : [];
  const text = [...(company.lodgingTypes || []), company.primaryName || company.name || ""].join(" ");
  return [...new Set([...explicit, ...INDUSTRIES.filter(item => item.pattern.test(text)).map(item => item.id)])];
}
function regionAliases(region) {
  const text = region.label || region.fullName || "";
  const short = text.replace("경상남도", "경남").replace("경상북도", "경북").replace("전라남도", "전남").replace("전북특별자치도", "전북").replace("전라북도", "전북").replace("충청남도", "충남").replace("충청북도", "충북").replace("경기도", "경기").replace("강원특별자치도", "강원").replace("강원도", "강원").replace("제주특별자치도", "제주").replace("서울특별시", "서울").replace("세종특별자치시", "세종").replace(/(부산|대구|인천|광주|대전|울산)광역시/g, "$1");
  return [...new Set([text, short, ...(region.aliases || [])].map(norm).filter(Boolean))];
}
function actualRegion(raw, regions) {
  const override = raw.manualCorrection?.regionOverride;
  const explicit = override || raw.regionKey || raw.regionId || "";
  if (explicit) {
    const matches = regions.filter(region => {
      const localName = String(region.label || "").trim().split(/\s+/).at(-1);
      return region.id === explicit || [...regionAliases(region), norm(localName), norm(localName).replace(/[시군구]$/, "")].includes(norm(explicit));
    });
    if (matches.length === 1) return matches[0];
    if (override) return null;
  }
  for (const address of raw.addresses || []) {
    const text = norm(typeof address === "string" ? address : address.address);
    const matches = regions.flatMap(region => regionAliases(region).filter(alias => text.startsWith(alias)).map(alias => ({ region, length: alias.length })));
    if (!matches.length) continue;
    const longest = Math.max(...matches.map(item => item.length));
    const unique = [...new Map(matches.filter(item => item.length === longest).map(item => [item.region.id, item.region])).values()];
    if (unique.length === 1) return unique[0];
  }
  return null;
}
function catalogRegions(regions = []) {
  return regions.filter(region => region.level !== "broad").map(region => ({ ...region,
    indicatorCandidate: CANDIDATES.some(name => String(region.label).endsWith(name)),
    ...(region.id === "kr_gyeongnam_sacheon" ? { coast: "남해안", indicatorCandidate: true } : {})
  }));
}
function rankCohort(source, request, companies) {
  const runs = new Map((source.runs || []).map(run => [String(run.id || run.runId), run]));
  const members = new Map(), excluded = {}, seen = new Set();
  const discard = reason => { excluded[reason] = (excluded[reason] || 0) + 1; };
  const evidenceKey = row => JSON.stringify([idOf(row), String(row.runId || ""), String(row.keyword || runs.get(String(row.runId || ""))?.keyword || "").trim()]);
  const hasRankValue = value => value !== undefined && value !== null && value !== "";
  const directRows = source.rankObservations || [], inventoryRows = source.observations || [];
  const directKeys = new Set(directRows.filter(row => hasRankValue(row.overallRank ?? row.rank)).map(evidenceKey));
  const overallRanks = new Map([...inventoryRows, ...directRows].filter(row => hasRankValue(row.overallRank)).map(row => [evidenceKey(row), row.overallRank]));
  // Some historical sources store the same rank on inventory rows. They may
  // provide rank evidence, but a row with no rank never creates membership.
  for (const row of [...directRows, ...inventoryRows.filter(row => !directKeys.has(evidenceKey(row)))]) {
    const id = idOf(row), runId = String(row.runId || ""), run = runs.get(runId);
    if (!companies.has(id)) continue;
    const keyword = String(row.keyword || run?.keyword || "").trim();
    const stamp = String(row.collectedAt || run?.collectedAt || "");
    const rankValue = overallRanks.has(evidenceKey(row)) ? overallRanks.get(evidenceKey(row)) : row.overallRank ?? row.rank;
    const key = JSON.stringify([id, runId, keyword, rankValue, stamp]);
    if (seen.has(key)) continue;
    seen.add(key);
    const day = dayOf(stamp);
    if (!day || (!row.collectedAt && run?.collectedAtSource === "filesystem")) { discard("unverified_rank_time"); continue; }
    if (!day.startsWith(request.month + "-") || day > request.cutoffDate) continue;
    if (!run || !["complete", "partial", "reused"].includes(qualityOf(run))) { discard("ineligible_rank_run"); continue; }
    if (run.searchMode === "company" || !keyword) { discard("not_keyword_rank"); continue; }
    const rank = rankValue === null || rankValue === "" || typeof rankValue === "boolean" ? NaN : Number(rankValue);
    if (!Number.isInteger(rank) || rank < 1) { discard("unknown_rank"); continue; }
    if (rank > 20) { discard("outside_top20"); continue; }
    if (!members.has(id)) members.set(id, []);
    members.get(id).push({ keyword, rank, collectedAt: stamp, runId, runQuality: qualityOf(run) });
  }
  for (const rows of members.values()) rows.sort((a, b) => b.collectedAt.localeCompare(a.collectedAt) || a.keyword.localeCompare(b.keyword));
  return { members, excluded };
}
const METRIC_KEYS = ["reservationRate", "averageBookedPrice", "revenuePerAvailableUnitDay"];
function metric(row, key) {
  if (key === "reservationRate") return ratio(row.sold, row.supply);
  if (!row.revenueEligible || row.revenuePartial) return null;
  return ratio(row.estimatedRevenue, key === "averageBookedPrice" ? row.sold : row.supply);
}
function summary(rows, companyCount, days) {
  const groups = new Map();
  for (const row of rows) { if (!groups.has(row.date)) groups.set(row.date, []); groups.get(row.date).push(row); }
  const metrics = Object.fromEntries(METRIC_KEYS.map(key => [key, mean([...groups.values()].map(day => mean(day.map(row => metric(row, key)))))]));
  const revenueRows = rows.filter(row => row.revenueEligible);
  const expected = companyCount * days;
  return { companyCount, observedCompanies: new Set(rows.map(idOf)).size, ...metrics,
    coveredCompanyDays: rows.length, expectedCompanyDays: expected, missingCompanyDays: Math.max(0, expected - rows.length),
    coverageRate: ratio(rows.length, expected), revenueCoveredCompanyDays: revenueRows.length,
    comparablePriceCompanyDays: rows.filter(row => metric(row, "averageBookedPrice") !== null).length,
    estimatedRevenue: sum(revenueRows, "estimatedRevenue"), publicRevenue: sum(revenueRows, "publicRevenue"), phoneRevenue: sum(revenueRows, "phoneRevenue"),
    publicBookings: sum(rows, "publicBookings"), phoneBookings: sum(rows, "phoneBookings"), supply: sum(rows, "supply"), sold: sum(rows, "sold"),
    sameDayObservedCompanyDays: rows.filter(row => row.observationLeadTimeDays === 0).length,
    availability: !rows.length ? "missing" : rows.length < expected ? "partial" : "observed",
    revenuePartial: revenueRows.length < expected || revenueRows.some(row => row.revenuePartial),
    metricBasis: "equal_company_within_date_then_equal_observed_dates" };
}
function industryComparison(companies, rows, regions, days) {
  const classified = INDUSTRIES.map(industry => {
    const selected = companies.filter(company => company.industryIds.includes(industry.id));
    const ids = new Set(selected.map(idOf));
    return { ...publicIndustry(industry), companies: selected, rows: rows.filter(row => ids.has(row.companyId)), regions: new Set(selected.filter(company => rows.some(row => row.companyId === company.companyId && row.supply > 0)).map(company => company.regionKey).filter(Boolean)) };
  });
  const active = classified.filter(industry => industry.rows.some(row => row.supply > 0));
  const candidates = active.length >= 2 ? [...active[0].regions].filter(id => active.every(industry => industry.regions.has(id))) : [];
  const companyMap = new Map(companies.map(company => [company.companyId, company]));
  const cells = new Map(active.map(industry => [industry.id, new Map()]));
  for (const industry of active) for (const row of industry.rows) {
    const region = companyMap.get(row.companyId)?.regionKey;
    if (!candidates.includes(region) || !(row.supply > 0)) continue;
    const key = `${region}|${row.date}`, map = cells.get(industry.id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  const commonPairs = active.length >= 2 ? [...cells.get(active[0].id).keys()].filter(key => active.every(industry => cells.get(industry.id).has(key))) : [];
  const metricPairs = Object.fromEntries(METRIC_KEYS.map(key => [key, commonPairs.filter(pair => active.every(industry => cells.get(industry.id).get(pair).some(row => metric(row, key) !== null)))]));
  const commonRegionIds = [...new Set(commonPairs.map(pair => pair.split("|")[0]))].sort();
  const commonDates = [...new Set(commonPairs.map(pair => pair.split("|")[1]))].sort();
  return { status: commonPairs.length ? "ready" : "insufficient", commonRegionIds, commonDates,
    regionDates: commonRegionIds.map(id => ({ id, label: regions.find(region => region.id === id)?.label || id, dates: commonPairs.filter(pair => pair.startsWith(id + "|")).map(pair => pair.split("|")[1]).sort() })),
    metricCommonPairs: Object.fromEntries(METRIC_KEYS.map(key => [key, metricPairs[key].length])),
    basis: "공통 실제 소재지와 공통 숙박일만 비교합니다. 날짜 안에서 업체를 동일 비중으로, 지역 안에서 날짜를 동일 비중으로, 지역끼리 동일 비중으로 계산합니다. 가격·객실당 매출은 각각 가격 근거가 있는 공통 지역·날짜만 사용합니다.",
    rows: classified.map(industry => {
      const pairedRows = commonPairs.flatMap(pair => cells.get(industry.id)?.get(pair) || []);
      const result = summary(pairedRows, new Set(pairedRows.map(idOf)).size, commonDates.length);
      for (const key of METRIC_KEYS) {
        const regional = new Map();
        for (const pair of metricPairs[key]) {
          const cell = cells.get(industry.id)?.get(pair);
          if (!cell) continue;
          const region = pair.split("|")[0];
          if (!regional.has(region)) regional.set(region, []);
          regional.get(region).push(mean(cell.map(row => metric(row, key))));
        }
        result[key] = mean([...regional.values()].map(mean));
      }
      const expected = industry.companies.reduce((total, company) => total + commonPairs.filter(pair => pair.startsWith(company.regionKey + "|")).length, 0);
      result.expectedCompanyDays = expected;
      result.missingCompanyDays = Math.max(0, expected - pairedRows.length);
      result.coverageRate = ratio(pairedRows.length, expected);
      result.availability = !pairedRows.length ? "missing" : pairedRows.length < expected ? "partial" : "observed";
      result.revenuePartial = result.revenueCoveredCompanyDays < expected || pairedRows.some(row => row.revenuePartial);
      return { id: industry.id, label: industry.label, unitLabel: industry.unitLabel, ...result,
        comparisonStatus: pairedRows.length ? "comparable" : "insufficient", availableCompanyCount: industry.companies.length,
        metricBasis: "common_region_date_equal_region_date_company", commonRegionCount: commonRegionIds.length };
    }) };
}
function buildIndustryAnalysis(source = {}, input = {}, { now = new Date() } = {}) {
  const request = normalizeRequest(input, now);
  const allCompanies = new Map((source.companies || []).filter(company => idOf(company) && !company.deletedAt && !company.mergedIntoCompanyId).map(company => [idOf(company), { ...company, companyId: idOf(company), industryIds: industryIds(company) }]));
  const regions = catalogRegions(source.regions);
  if (request.region !== "all" && !regions.some(region => region.id === request.region)) throw fail("invalid_region", "분석 가능한 지역을 선택해 주세요.");
  const cohort = rankCohort(source, request, allCompanies);
  const members = [...allCompanies.values()].filter(company => cohort.members.has(company.companyId));
  const scoped = members.filter(company => request.region === "all" || company.regionKey === request.region);
  const selected = scoped.filter(company => company.industryIds.includes(request.industry));
  // A synthetic region merely scopes the existing engine to canonical members.
  // No location is inferred from the search keyword.
  const snapshot = buildMonthlyReportSnapshot({ type: "region", targetId: "__industry_cohort__", month: request.month, cutoffDate: request.cutoffDate },
    { ...source, companies: scoped.map(company => ({ ...company, regionKeys: [...(company.regionKeys || []), "__industry_cohort__"] })) }, new Date(now).toISOString());
  const allRows = snapshot.sources.observations.filter(row => row.productType === "lodging");
  const selectedIds = new Set(selected.map(idOf)), rows = allRows.filter(row => selectedIds.has(row.companyId));
  const dates = snapshot.daily.map(row => row.date), days = snapshot.period.days;
  const regionRows = regions.filter(region => region.indicatorCandidate || selected.some(company => company.regionKey === region.id)).map(region => {
    const companies = selected.filter(company => company.regionKey === region.id), ids = new Set(companies.map(idOf));
    return { ...region, ...summary(rows.filter(row => ids.has(row.companyId)), companies.length, days), comparisonStatus: "descriptive_only" };
  });
  const unknownRegionCount = selected.filter(company => !company.regionKey).length;
  const warnings = ["네이버 플레이스 1~20위에서 관측된 업체 표본이며 지역 전체 시장을 대표하지 않습니다.",
    "기간 중 1~20위에 한 번이라도 관측된 업체의 통합 실적입니다. 표본은 20개를 넘을 수 있으며 순위 진입 전·이탈 후 숙박일도 포함합니다. 날짜별 당시 1~20위 실적과 다릅니다.",
    "보존된 순위 이력만 사용합니다. 오래된 순위 이력이 없으면 당시 1~20위 전체를 복원할 수 없으며 순위 미확인 업체를 임의로 채우지 않습니다.",
    "복합시설은 해당 업종 각각에 시설 전체 실적을 포함합니다. 업종별 값을 더하면 중복되므로 전체 합계로 사용할 수 없습니다.",
    "예약과 매출은 저장된 숙박 재고의 추정값입니다. 수집 누락은 0이 아니며 금액은 관측된 업체·날짜의 소계입니다.",
    "지역별 표는 관측 현황입니다. 관측 날짜와 업체 수가 달라 성과 순위로 해석하지 않습니다.",
    ...snapshot.quality.warnings, ...(source.warnings || [])];
  if (unknownRegionCount) warnings.push(`실제 소재지가 확인되지 않은 업체 ${unknownRegionCount}개는 전체 현황에만 포함하고 지역 비교에서는 제외했습니다.`);
  const unclassified = scoped.filter(company => !company.industryIds.length).length;
  if (unclassified) warnings.push(`저장 업종이나 업체명으로 업종을 확인하지 못한 업체 ${unclassified}개는 업종별 집계에서 제외했습니다.`);
  return { schemaVersion: 1, generatedAt: new Date(now).toISOString(), request, industry: publicIndustry(INDUSTRIES.find(item => item.id === request.industry)),
    period: snapshot.period, cohort: { ...COHORT, membershipCompanyCount: scoped.length, selectedCompanyCount: selected.length }, features: FEATURES, scalePolicy: DEFERRED_SCALE,
    summary: summary(rows, selected.length, days), daily: dates.map(date => ({ date, ...summary(rows.filter(row => row.date === date), selected.length, 1) })),
    regions: regionRows, industryComparison: industryComparison(scoped, allRows, regions, days),
    companies: selected.map(company => ({ companyId: company.companyId, primaryName: company.primaryName || company.companyId,
      regionKey: company.regionKey || "", regionLabel: company.regionLabel || "지역 확인 전", industryIds: company.industryIds,
      classificationBasis: "saved_category_and_name", capacity: finite(company.capacity) ? company.capacity : null, capacitySource: company.capacitySource || "확인 전",
      capacityBasis: company.capacityBasis ? structuredClone(company.capacityBasis) : null,
      rankEvidence: cohort.members.get(company.companyId), primaryRunId: cohort.members.get(company.companyId)[0]?.runId || null,
      ...summary(rows.filter(row => row.companyId === company.companyId), 1, days) })).sort((a, b) => a.primaryName.localeCompare(b.primaryName, "ko")),
    quality: { warnings: [...new Set(warnings)], rankExcludedByReason: cohort.excluded, unknownRegionCompanies: unknownRegionCount, unclassifiedCompanies: unclassified,
      discardedByReason: snapshot.quality.discardedByReason, excludedCompanies: allCompanies.size - members.length, status: rows.length ? "partial" : "missing" },
    sources: { runIds: snapshot.sources.runIds, observationPolicy: snapshot.sources.observationPolicy, rankPolicy: "valid_keyword_rank_1_to_20_observed_within_month_before_cutoff" },
    context: { sources: [], warnings: [], networkAttempted: false },
    definitions: { cohort: "선택 월(한국시간)에 유효하게 관측된 검색어별 1~20위 업체의 합집합입니다. 같은 업체는 검색어·회차가 달라도 한 번만 계산합니다. 업체명 검색의 순위와 순위 미확인 자료는 제외합니다.",
      reservationRate: "날짜별로 업체의 예약 추정 수량/공급 수량을 동일 비중 평균한 뒤 관측 날짜끼리 동일 비중으로 평균합니다.",
      averageBookedPrice: "가격이 확인된 업체·날짜의 추정매출/예약 추정 수량을 같은 방식으로 평균합니다. 예약이 없는 날짜는 가격 평균에서 제외합니다.",
      revenuePerAvailableUnitDay: "가격이 확인된 업체·날짜의 추정매출/공급 수량을 같은 방식으로 평균합니다. 업종별 판매 단위가 다르므로 수익성 순위가 아닙니다.",
      coverage: "기간 중 1~20위에 관측된 업체 수 × 선택 월의 전체 일수 대비 유효한 업체·숙박일 관측 수입니다.",
      estimatedRevenue: "가격 근거가 있는 관측의 추정매출 소계이며 월 전체 매출이 아닙니다. 공개 예약과 전화·타채널 추정을 구분합니다.",
      region: "업체 DB의 실제 주소와 검토한 지역 코드를 사용합니다. 검색어의 지역명을 실제 소재지로 대체하지 않습니다.",
      industry: "저장 업종과 업체명에 명시된 업종으로 분류합니다. 검색어만으로 업종을 확정하지 않습니다." } };
}

function createIndustryAnalysisService({ sources, readContext = async () => ({ sources: [], warnings: [], networkAttempted: false }), now = () => new Date() }) {
  const sourceCache = new Map();
  const pendingSources = new Map();
  let sourceReadQueue = Promise.resolve();
  async function savedSource(request, date) {
    const key = `${request.month}|${request.cutoffDate}`;
    // Expiry and the completed-cache limit must never evict running work.
    // A saved month can take longer than the cache TTL to reconstruct.
    if (pendingSources.has(key)) return pendingSources.get(key);
    const cached = sourceCache.get(key);
    if (cached && cached.expires > new Date(date).getTime()) return cached.value;
    if (cached) sourceCache.delete(key);
    // Distinct months can each reconstruct the complete saved source. Serialize
    // those reads to avoid multiplying their peak memory under concurrent tabs.
    const promise = sourceReadQueue.then(async () => {
      const sourceRequest = { type: "industry", targetId: "__industry_all__", month: request.month, cutoffDate: request.cutoffDate };
      if (typeof sources.loadSourcesWithCatalog === "function") {
        // The adapter shares the exact prepared catalog used for correction,
        // avoiding a second master parse/clone retained during a long read.
        const pair = await sources.loadSourcesWithCatalog(sourceRequest);
        return compactIndustrySources(pair.source, pair.catalog);
      }
      // Compatibility for adapters without the paired reader. Wait for both
      // readers before releasing a failed pending key.
      const results = await Promise.allSettled([sources.loadSources(sourceRequest), sources.catalog()]);
      const failed = results.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
      return compactIndustrySources(results[0].value, results[1].value);
    });
    sourceReadQueue = promise.then(() => undefined, () => undefined);
    pendingSources.set(key, promise);
    try {
      const value = await promise;
      sourceCache.set(key, { value, expires: new Date(now()).getTime() + 30000 });
      while (sourceCache.size > 2) sourceCache.delete(sourceCache.keys().next().value);
      return value;
    } finally {
      if (pendingSources.get(key) === promise) pendingSources.delete(key);
    }
  }
  async function options() {
    const [options, catalog] = await Promise.all([sources.options(), sources.catalog()]);
    const runMap = new Map((catalog.runs || []).map(run => [String(run.id || run.runId), run]));
    const today = options.today || new Date(new Date(now()).getTime() + 9 * 3600000).toISOString().slice(0, 10);
    const evidenceMonths = new Set();
    for (const company of catalog.rawCompanies.values()) for (const exposure of Object.values(company.keywords || {})) for (const row of exposure.runs || []) {
      const run = runMap.get(String(row.runId || "")), day = dayOf(row.collectedAt || run?.collectedAt);
      const rank = Number(row.overallRank ?? row.rank);
      if (!run || run.searchMode === "company" || !["complete", "reused", "partial"].includes(qualityOf(run))
        || !day || day > today || (!row.collectedAt && run.collectedAtSource === "filesystem") || !Number.isInteger(rank) || rank < 1 || rank > 20) continue;
      if ((options.months || []).includes(day.slice(0, 7))) evidenceMonths.add(day.slice(0, 7));
    }
    // Older rank-only exposures may no longer be retained. In that case prefer
    // a saved keyword-run month over the monthly menu's synthetic current month.
    const savedRunMonths = [...new Set([...runMap.values()].filter(run => run.searchMode !== "company" && run.collectedAtSource !== "filesystem"
      && ["complete", "reused", "partial"].includes(qualityOf(run)) && dayOf(run.collectedAt) && dayOf(run.collectedAt) <= today)
      .map(run => dayOf(run.collectedAt).slice(0, 7)).filter(month => (options.months || []).includes(month)))].sort().reverse();
    const availableEvidenceMonths = [...evidenceMonths].sort().reverse();
    const defaultMonth = availableEvidenceMonths[0] || savedRunMonths[0] || options.defaultMonth;
    return { industries: INDUSTRIES.map(publicIndustry), regions: catalogRegions(options.regions), months: options.months,
      defaultMonth, availableEvidenceMonths, defaultIndustry: "glamping", today, cohort: COHORT, features: FEATURES, scalePolicy: DEFERRED_SCALE };
  }
  async function analyze(input) {
    const date = now(), request = normalizeRequest(input, date);
    const { source, catalog } = await savedSource(request, date);
    const result = buildIndustryAnalysis(source, request, { now: date });
    if (request.region !== "all") {
      const context = await readContext({ type: "region", targetId: request.region, month: request.month, cutoffDate: request.cutoffDate }, { ...catalog, companies: source.companies });
      if (context?.networkAttempted) throw Object.assign(new Error("저장된 지역 지표만 사용할 수 있습니다."), { code: "INDUSTRY_CONTEXT_MUST_BE_CACHE_ONLY", statusCode: 503 });
      result.context = context;
    } else result.context.warnings = ["지역을 선택하면 저장된 방문·체류·소비 지표를 함께 확인할 수 있습니다. 사천은 남해안 지표 지역에 포함합니다."];
    return result;
  }
  return { options, analyze };
}

module.exports = { buildIndustryAnalysis, createIndustryAnalysisService, compactIndustrySources,
  normalizeIndustryAnalysisRequest: normalizeRequest, industryAnalysisIndustries: INDUSTRIES.map(publicIndustry) };
