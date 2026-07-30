"use strict";

const CATEGORY_DEFINITIONS = Object.freeze({
  glamping: { label: "글램핑", terms: ["글램핑장", "글램핑"] },
  campground: { label: "캠핑장", terms: ["오토캠핑장", "캠핑장", "야영장"] },
  caravan: { label: "카라반", terms: ["카라반"] },
  pension: { label: "펜션", terms: ["키즈펜션", "스파펜션", "애견펜션", "펜션"] },
  poolVilla: { label: "풀빌라", terms: ["독채풀빌라", "풀빌라펜션", "풀빌라"] },
  privateStay: { label: "독채스테이", terms: ["프라이빗스테이", "독채스테이", "한옥스테이", "감성숙소"] }
});

const CATEGORY_ORDER = ["poolVilla", "privateStay", "glamping", "campground", "caravan", "pension"];
const PRIVATE_STAY_FALSE_POSITIVES = ["스테이폴리오", "stayfolio", "호텔스테이", "스테이 123", "스테이123"];

function normalizeText(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

function compactText(value) {
  return normalizeText(value).replace(/\s+/g, "").toLowerCase();
}

function unique(values) {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function categoryDefinition(key) {
  return CATEGORY_DEFINITIONS[key] || null;
}

function categoryTerm(key) {
  return categoryDefinition(key)?.label || "";
}

function spacedRegionCategory(region, categoryKey) {
  return unique([region, categoryTerm(categoryKey)]).join(" ");
}

function createLodgingSearchContext(input = {}) {
  const originalKeyword = normalizeText(input.originalKeyword || input.keyword);
  const intent = normalizeText(input.intent || input.searchIntent) || "";
  const regionKey = normalizeText(input.regionKey || input.searchRegionKey);
  const regionQuery = normalizeText(input.regionQuery || input.searchRegionQuery);
  const companyName = normalizeText(input.companyName || input.searchCompanyName);
  const categoryKey = CATEGORY_DEFINITIONS[input.lodgingCategoryKey] ? input.lodgingCategoryKey : "";
  const selectedCandidate = input.selectedCandidate && typeof input.selectedCandidate === "object"
    ? { mode: normalizeText(input.selectedCandidate.mode), query: normalizeText(input.selectedCandidate.query) }
    : null;
  let primaryQuery = selectedCandidate?.query || originalKeyword;
  const fallbacks = [];

  if (intent === "region_search") {
    primaryQuery = regionQuery && categoryKey ? spacedRegionCategory(regionQuery, categoryKey) : (primaryQuery || regionQuery);
    fallbacks.push(originalKeyword, compactText(primaryQuery));
  } else if (intent === "company_in_region") {
    primaryQuery = originalKeyword || unique([regionQuery, companyName]).join(" ");
    fallbacks.push(companyName, unique([regionQuery, companyName]).join(" "));
  } else if (intent === "company_search") {
    primaryQuery = companyName || originalKeyword;
    fallbacks.push(originalKeyword);
  }

  primaryQuery = primaryQuery || originalKeyword;
  const fallbackQueries = unique(fallbacks).filter((query) => compactText(query) !== compactText(primaryQuery));
  const normalizedQuery = compactText(primaryQuery);
  const queryEvidence = [];
  if (regionQuery) queryEvidence.push(`지역: ${regionQuery}`);
  if (companyName) queryEvidence.push(`업체명: ${companyName}`);
  if (categoryKey) queryEvidence.push(`숙소 유형: ${categoryKey}`);
  if (selectedCandidate?.mode) queryEvidence.push(`선택 후보: ${selectedCandidate.mode}`);

  return {
    originalKeyword,
    intent,
    regionKey,
    regionQuery,
    companyName,
    categoryKey,
    selectedCandidate,
    primaryQuery,
    fallbackQueries,
    normalizedQuery,
    queryEvidence,
    platformQueries: {
      naver: unique([primaryQuery, ...fallbackQueries]),
      nol: unique([primaryQuery, ...fallbackQueries]),
      ddnayo: {
        exact: primaryQuery,
        normalized: normalizedQuery,
        fallbacks: fallbackQueries
      }
    }
  };
}

function collectionContextFromEnv(env = process.env, keyword = "") {
  let selectedCandidate = null;
  if (env.SEARCH_CANDIDATE_MODE || env.SEARCH_CANDIDATE_QUERY) {
    selectedCandidate = {
      mode: env.SEARCH_CANDIDATE_MODE || "",
      query: env.SEARCH_CANDIDATE_QUERY || keyword
    };
  }
  return createLodgingSearchContext({
    originalKeyword: keyword,
    intent: env.SEARCH_INTENT,
    regionKey: env.SEARCH_REGION_KEY,
    regionQuery: env.SEARCH_REGION_QUERY,
    companyName: env.SEARCH_COMPANY_NAME,
    lodgingCategoryKey: env.LODGING_CATEGORY_KEY,
    selectedCandidate
  });
}

function fieldText(row = {}) {
  const values = [
    row.name,
    row.title,
    row.companyName,
    row.category,
    row.productName,
    row.roomName,
    row.description,
    row.facilities
  ];
  return normalizeText(values.filter(Boolean).join(" "));
}

function detectLodgingCategories(row = {}) {
  const text = compactText(fieldText(row));
  if (!text) return { primaryCategoryKey: "", categoryTags: [], confidence: 0, evidence: [] };
  const tags = [];
  const evidence = [];
  for (const key of CATEGORY_ORDER) {
    const definition = CATEGORY_DEFINITIONS[key];
    const matched = definition.terms.find((term) => text.includes(compactText(term)));
    if (!matched) continue;
    if (key === "privateStay" && PRIVATE_STAY_FALSE_POSITIVES.some((term) => text.includes(compactText(term)))) continue;
    tags.push(key);
    evidence.push(`${matched}: ${key} 신호`);
  }
  if (tags.includes("poolVilla") && text.includes("펜션") && !tags.includes("pension")) tags.push("pension");
  const primaryCategoryKey = tags[0] || "";
  return {
    primaryCategoryKey,
    categoryTags: unique(tags),
    confidence: primaryCategoryKey ? Math.min(0.98, 0.78 + tags.length * 0.08) : 0,
    evidence
  };
}

function companyMatch(name, target) {
  const left = compactText(name);
  const right = compactText(target);
  if (!left || !right) return { matched: false, score: 0 };
  if (left === right) return { matched: true, score: 100 };
  if (left.includes(right) || right.includes(left)) return { matched: true, score: 85 };
  return { matched: false, score: 0 };
}

function categoryCompatible(requested, detected = []) {
  if (!requested) return true;
  if (detected.includes(requested)) return true;
  return requested === "pension" && detected.includes("poolVilla");
}

function evaluateLodgingRelevance(row = {}, context = {}) {
  const search = context.primaryQuery ? context : createLodgingSearchContext(context);
  const detection = detectLodgingCategories(row);
  const location = normalizeText(row.location || row.address);
  const regionMatched = !search.regionQuery || !location
    ? null
    : compactText(location).includes(compactText(search.regionQuery));
  const company = companyMatch(row.name || row.title || row.companyName, search.companyName);
  const requested = search.categoryKey || "";
  const categoryMatched = categoryCompatible(requested, detection.categoryTags);
  let relevant = true;
  let relevanceScore = 40;
  let rejectionReason = "";

  if (company.matched) relevanceScore += company.score >= 100 ? 45 : 35;
  if (regionMatched === true) relevanceScore += 20;
  if (regionMatched === false && search.intent === "region_search") {
    relevant = false;
    rejectionReason = "요청 지역과 결과 주소가 다릅니다.";
  }
  if (requested && categoryMatched) relevanceScore += 35;
  if (requested && !categoryMatched) {
    if ((search.intent === "company_search" || search.intent === "company_in_region") && company.matched) {
      relevanceScore = Math.max(relevanceScore, 55);
    } else {
      relevant = false;
      rejectionReason ||= detection.primaryCategoryKey
        ? `요청 유형 ${requested}과 결과 유형 ${detection.primaryCategoryKey}이 다릅니다.`
        : `요청 유형 ${requested}의 근거를 확인하지 못했습니다.`;
    }
  }
  if (!requested && detection.primaryCategoryKey) relevanceScore += 20;
  if (!requested && !detection.primaryCategoryKey && /호텔|모텔/.test(fieldText(row))) {
    relevant = false;
    rejectionReason = "숙박 유형 검색 근거가 없는 호텔·모텔 결과입니다.";
  }

  return {
    relevant,
    categoryKey: detection.primaryCategoryKey,
    categoryTags: detection.categoryTags,
    categoryConfidence: detection.confidence,
    categoryEvidence: detection.evidence,
    regionMatched,
    companyMatched: company.matched,
    relevanceScore: Math.max(0, Math.min(100, relevanceScore)),
    rejectionReason
  };
}

function decorateLodgingResult(row = {}, context = {}, sourceQuery = "") {
  const result = evaluateLodgingRelevance(row, context);
  return {
    ...row,
    requestedLodgingCategoryKey: context.categoryKey || "",
    detectedLodgingCategoryKey: result.categoryKey,
    detectedLodgingCategoryTags: result.categoryTags,
    categoryConfidence: result.categoryConfidence,
    categoryEvidence: result.categoryEvidence,
    relevanceScore: result.relevanceScore,
    relevanceStatus: result.relevant ? (result.companyMatched && !result.categoryKey ? "review" : "matched") : "rejected",
    relevanceRejectionReason: result.rejectionReason,
    searchIntent: context.intent || "",
    searchRegionKey: context.regionKey || "",
    searchRegionQuery: context.regionQuery || "",
    searchCompanyName: context.companyName || "",
    sourceQuery: normalizeText(sourceQuery || context.primaryQuery),
    regionMatched: result.regionMatched,
    companyMatched: result.companyMatched
  };
}

module.exports = {
  CATEGORY_DEFINITIONS,
  collectionContextFromEnv,
  createLodgingSearchContext,
  decorateLodgingResult,
  detectLodgingCategories,
  evaluateLodgingRelevance
};
