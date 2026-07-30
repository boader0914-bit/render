"use strict";
const assert = require("node:assert/strict");
global.fetch = () => { throw new Error("Network calls are forbidden in lodging category profile tests"); };
const { categorySummary, confidenceProfile, normalizeCompanyCategory } = require("./lodging_category_profile.cjs");

const companies = [
  { primaryCategoryKey: "glamping", categoryTags: ["glamping", "caravan", "caravan"], categoryConfidence: 0.91, sourcePlatforms: ["naver", "naver"] },
  { primaryCategoryKey: "poolVilla", categoryTags: ["poolVilla", "pension"], categoryConfidence: 0.92, sourcePlatforms: ["nol", "ddnayo"] },
  { categoryKey: "pension", categoryTags: "invalid", sourcePlatforms: ["naver"] },
  { primaryCategoryKey: "privateStay", categoryTags: ["privateStay"], sourcePlatforms: ["naver"], manualCorrection: { primaryCategoryKey: "pension", categoryTags: ["pension", "poolVilla"], categoryNote: "현장 확인", note: "기존 메모" } },
  { primaryCategoryKey: "stayfolio", categoryTags: ["stayfolio", "privateStayBad"], sourcePlatforms: ["cookie", "headers"] },
  { primaryCategoryKey: "privateStay", categoryTags: ["privateStay"], categoryEvidence: [
    { categoryKey: "privateStay", source: "naver", reason: "독채스테이 명시", confidence: 0.94, observedAt: "2026-07-30T00:00:00Z", headers: "drop" }
  ], duplicateReview: { status: "pending", candidateCompanyIds: ["secret"] } }
];
const manual = normalizeCompanyCategory(companies[3]);
assert.equal(manual.primaryCategoryKey, "pension");
assert.equal(manual.manualCategoryOverride, true);
assert.deepEqual(manual.categoryTags, ["pension", "poolVilla", "privateStay"]);
assert.equal(manual.categoryEvidenceSummary.length, 0);
const unknown = normalizeCompanyCategory(companies[4]);
assert.equal(unknown.primaryCategoryKey, "");
assert.deepEqual(unknown.categoryTags, []);
assert.deepEqual(unknown.sourcePlatforms, []);
const evidence = normalizeCompanyCategory(companies[5]);
assert.equal(evidence.categoryEvidenceSummary[0].reason, "독채스테이 명시");
assert.equal("headers" in evidence.categoryEvidenceSummary[0], false);
assert.equal(evidence.duplicateReviewStatus, "pending");
assert.equal(confidenceProfile(0.95).label, "높음");
assert.equal(confidenceProfile(0.75).label, "보통");
assert.equal(confidenceProfile(0.4).label, "검토 필요");
assert.equal(confidenceProfile(0).label, "미확인");
const summary = categorySummary(companies);
assert.equal(summary.totalCompanies, 6);
assert.equal(Object.values(summary.primaryCounts).reduce((sum, count) => sum + count, 0), 6);
assert.equal(summary.primaryCounts.unknown, 1);
assert.equal(summary.primaryCounts.pension, 2);
assert.equal(summary.tagCounts.caravan, 1);
assert.equal(summary.tagCounts.pension, 3);
assert.equal(summary.manualOverrideCount, 1);
assert.equal(summary.duplicateReviewCount, 1);
assert.equal(summary.sourcePlatformCounts.naver, 3);
console.log("Lodging category profile and analytics fixture tests passed without network or file I/O");
