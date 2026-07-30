"use strict";

(function init(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LodgingCategoryProfile = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function factory() {
  const CATEGORY_PROFILES = Object.freeze({
    glamping: Object.freeze({ label: "글램핑", shortLabel: "글램핑", order: 10 }),
    campground: Object.freeze({ label: "캠핑장", shortLabel: "캠핑", order: 20 }),
    caravan: Object.freeze({ label: "카라반", shortLabel: "카라반", order: 30 }),
    pension: Object.freeze({ label: "펜션", shortLabel: "펜션", order: 40 }),
    poolVilla: Object.freeze({ label: "풀빌라", shortLabel: "풀빌라", order: 50 }),
    privateStay: Object.freeze({ label: "독채·스테이", shortLabel: "스테이", order: 60 })
  });
  const PLATFORM_LABELS = Object.freeze({
    naver: "네이버", nol: "NOL", ddnayo: "떠나요", yeogi_manual: "여기어때 수동",
    tourism_public: "공공·관광 데이터", manual: "관리자 확인"
  });
  const keys = Object.keys(CATEGORY_PROFILES);
  const validKey = (value) => keys.includes(String(value || "").trim()) ? String(value).trim() : "";
  const unique = (values) => [...new Set((Array.isArray(values) ? values : []).map(validKey).filter(Boolean))]
    .sort((a, b) => CATEGORY_PROFILES[a].order - CATEGORY_PROFILES[b].order);
  const confidenceProfile = (value) => {
    const confidence = Math.max(0, Math.min(1, Number(value) || 0));
    if (confidence >= 0.9) return { key: "high", label: "높음", confidence };
    if (confidence >= 0.7) return { key: "medium", label: "보통", confidence };
    if (confidence > 0) return { key: "review", label: "검토 필요", confidence };
    return { key: "unknown", label: "미확인", confidence: 0 };
  };
  function normalizeCompanyCategory(company = {}) {
    const manual = company.manualCorrection && typeof company.manualCorrection === "object" ? company.manualCorrection : {};
    const automaticPrimary = validKey(company.primaryCategoryKey || company.categoryKey);
    const manualPrimary = validKey(manual.primaryCategoryKey);
    const primaryCategoryKey = manualPrimary || automaticPrimary;
    const categoryTags = unique([
      primaryCategoryKey,
      ...(Array.isArray(company.categoryTags) ? company.categoryTags : []),
      ...(Array.isArray(manual.categoryTags) ? manual.categoryTags : [])
    ]);
    const evidence = (Array.isArray(company.categoryEvidence) ? company.categoryEvidence : [])
      .filter((row) => row && validKey(row.categoryKey))
      .map((row) => ({
        categoryKey: validKey(row.categoryKey),
        categoryLabel: CATEGORY_PROFILES[validKey(row.categoryKey)].label,
        source: String(row.source || "").trim(), reason: String(row.reason || "").trim().slice(0, 180),
        confidence: Math.max(0, Math.min(1, Number(row.confidence) || 0)), observedAt: String(row.observedAt || "")
      }))
      .sort((a, b) => b.confidence - a.confidence || String(b.observedAt).localeCompare(String(a.observedAt)))
      .slice(0, 12);
    const sourcePlatforms = [...new Set((Array.isArray(company.sourcePlatforms) ? company.sourcePlatforms : [])
      .map((value) => String(value || "").trim()).filter((value) => PLATFORM_LABELS[value]))];
    return {
      primaryCategoryKey,
      primaryCategoryLabel: primaryCategoryKey ? CATEGORY_PROFILES[primaryCategoryKey].label : "유형 미확인",
      categoryTags,
      categoryLabels: categoryTags.map((key) => CATEGORY_PROFILES[key].label),
      categoryConfidence: Math.max(0, Math.min(1, Number(company.categoryConfidence) || 0)),
      categoryEvidenceSummary: evidence,
      sourcePlatforms,
      sourcePlatformLabels: sourcePlatforms.map((key) => PLATFORM_LABELS[key]),
      manualCategoryOverride: Boolean(manualPrimary),
      duplicateReviewStatus: company.duplicateReview?.status === "pending" ? "pending" : "",
      confidenceProfile: confidenceProfile(company.categoryConfidence)
    };
  }
  function categorySummary(companies = []) {
    const rows = Array.isArray(companies) ? companies : [];
    const primaryCounts = Object.fromEntries([...keys, "unknown"].map((key) => [key, 0]));
    const tagCounts = Object.fromEntries(keys.map((key) => [key, 0]));
    const sourcePlatformCounts = {};
    let manualOverrideCount = 0;
    let duplicateReviewCount = 0;
    for (const company of rows) {
      const profile = normalizeCompanyCategory(company);
      primaryCounts[profile.primaryCategoryKey || "unknown"] += 1;
      profile.categoryTags.forEach((key) => { tagCounts[key] += 1; });
      profile.sourcePlatforms.forEach((key) => { sourcePlatformCounts[key] = (sourcePlatformCounts[key] || 0) + 1; });
      if (profile.manualCategoryOverride) manualOverrideCount += 1;
      if (profile.duplicateReviewStatus === "pending") duplicateReviewCount += 1;
    }
    return { totalCompanies: rows.length, primaryCounts, tagCounts, manualOverrideCount, duplicateReviewCount, sourcePlatformCounts };
  }
  return { CATEGORY_PROFILES, PLATFORM_LABELS, categorySummary, confidenceProfile, normalizeCompanyCategory, validKey };
});
