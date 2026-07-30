"use strict";

const assert = require("node:assert/strict");
global.fetch = () => { throw new Error("Network calls are forbidden in company identity fixture tests"); };

const {
  MAX_EVIDENCE,
  applyObservationToCompany,
  decideCompanyMatch,
  mergeCompanyCategoryProfiles,
  phoneKey,
  standardizeCompanyObservation
} = require("./lodging_company_identity.cjs");

const at = "2026-07-30T10:00:00.000Z";
const baseCompany = {
  companyId: "cmp_blue",
  primaryName: "경주 블루 풀빌라펜션",
  nameKey: "경주블루풀빌라펜션",
  aliases: ["경주 블루 풀빌라펜션"],
  regions: ["경주"],
  addresses: ["경상북도 경주시 보문로 10"],
  placeIds: ["naver-123"],
  bookingBusinessIds: [],
  firstSeenAt: "2026-07-01T00:00:00.000Z",
  createdAt: "2026-07-01T00:00:00.000Z",
  customUserField: { keep: true },
  manualCorrection: null
};

const naverRepeat = standardizeCompanyObservation({
  sourcePlatform: "naver",
  sourceId: "naver-123",
  name: "경주 블루 풀빌라펜션",
  address: "경상북도 경주시 보문로 10",
  region: "경주",
  detectedCategoryKey: "poolVilla",
  categoryTags: ["poolVilla", "pension"],
  categoryConfidence: 0.94,
  categoryEvidence: [{ categoryKey: "poolVilla", source: "naver", reason: "업체명에 풀빌라 포함", confidence: 0.94, observedAt: at }],
  observedAt: at,
  headers: { cookie: "must-not-save" },
  clientIntentPreview: { intent: "forged" }
});
assert.equal(decideCompanyMatch(naverRepeat, [baseCompany]).decision, "merge");
assert.equal(decideCompanyMatch(naverRepeat, [baseCompany]).score, 100);

const sameByAddress = standardizeCompanyObservation({
  sourcePlatform: "nol",
  sourceId: "nol-777",
  name: "경주 블루 풀빌라펜션",
  address: "경상북도 경주시 보문로 10",
  region: "경주",
  detectedCategoryKey: "poolVilla",
  categoryTags: ["poolVilla", "pension"],
  categoryConfidence: 0.92,
  observedAt: at
});
assert.equal(decideCompanyMatch(sameByAddress, [baseCompany]).decision, "merge");

const phoneCompany = { ...baseCompany, companyId: "cmp_phone", placeIds: [], phones: ["054-123-4567"] };
const phoneObservation = standardizeCompanyObservation({ sourcePlatform: "ddnayo", name: "블루 풀빌라", phone: "0541234567", region: "경주" });
assert.equal(phoneKey("+82 54-123-4567"), phoneKey("054-123-4567"));
assert.equal(decideCompanyMatch(phoneObservation, [phoneCompany]).decision, "merge");

const otherRegion = standardizeCompanyObservation({ sourcePlatform: "nol", name: "경주 블루 풀빌라펜션", address: "부산광역시 해운대구 20", region: "부산" });
assert.equal(decideCompanyMatch(otherRegion, [baseCompany]).decision, "create");

const similarReview = standardizeCompanyObservation({ sourcePlatform: "nol", name: "경주 블루 풀빌라 펜션", address: "경상북도 경주시 보문로 10 별관", region: "경주" });
assert.equal(decideCompanyMatch(similarReview, [baseCompany]).decision, "review");

const differentNameReview = standardizeCompanyObservation({ sourcePlatform: "ddnayo", name: "보문 프라이빗 빌라", address: "경상북도 경주시 보문로 10", region: "경주" });
assert.equal(decideCompanyMatch(differentNameReview, [baseCompany]).decision, "review");

const appliedOnce = applyObservationToCompany(baseCompany, naverRepeat);
assert.equal(appliedOnce.company.primaryCategoryKey, "poolVilla");
assert.deepEqual(appliedOnce.company.categoryTags, ["poolVilla", "pension"]);
assert.equal(appliedOnce.company.categoryConfidence, 0.94);
assert.deepEqual(appliedOnce.company.sourcePlatforms, ["naver"]);
assert.deepEqual(appliedOnce.company.sourcePlatformIds.naver, ["naver-123"]);
assert.equal(appliedOnce.company.companyId, baseCompany.companyId);
assert.equal(appliedOnce.company.createdAt, baseCompany.createdAt);
assert.deepEqual(appliedOnce.company.customUserField, { keep: true });
assert.equal("headers" in appliedOnce.company, false);
assert.equal("clientIntentPreview" in appliedOnce.company, false);

const appliedTwice = applyObservationToCompany(appliedOnce.company, naverRepeat);
assert.equal(appliedTwice.changed, false);
assert.deepEqual(appliedTwice.company.categoryEvidence, appliedOnce.company.categoryEvidence);

const nolApplied = applyObservationToCompany(appliedOnce.company, sameByAddress);
assert.deepEqual(nolApplied.company.sourcePlatforms, ["naver", "nol"]);
assert.equal(nolApplied.company.categoryEvidence.length, 2);

const manualCompany = {
  ...baseCompany,
  primaryCategoryKey: "poolVilla",
  categoryTags: ["poolVilla"],
  manualCorrection: {
    primaryCategoryKey: "pension",
    categoryTags: ["pension"],
    categoryNote: "관리자 현장 확인",
    note: "기존 객실 메모",
    updatedAt: at
  }
};
const manualApplied = applyObservationToCompany(manualCompany, naverRepeat).company;
assert.equal(manualApplied.primaryCategoryKey, "pension");
assert.ok(manualApplied.categoryTags.includes("poolVilla"));
assert.ok(manualApplied.categoryTags.includes("pension"));
assert.equal(manualApplied.manualCorrection.note, "기존 객실 메모");

const legacyCompany = { ...baseCompany, categoryKey: "glamping", categoryTags: "invalid", unknownLegacy: 123 };
const legacyApplied = applyObservationToCompany(legacyCompany, standardizeCompanyObservation({ sourcePlatform: "ddnayo", name: baseCompany.primaryName, detectedCategoryKey: "caravan", categoryTags: ["caravan"], categoryConfidence: 0.9, observedAt: at })).company;
assert.ok(legacyApplied.categoryTags.includes("glamping"));
assert.ok(legacyApplied.categoryTags.includes("caravan"));
assert.equal(legacyApplied.unknownLegacy, 123);

let capped = baseCompany;
for (let index = 0; index < MAX_EVIDENCE + 12; index += 1) {
  capped = applyObservationToCompany(capped, standardizeCompanyObservation({
    sourcePlatform: "naver",
    name: baseCompany.primaryName,
    detectedCategoryKey: "poolVilla",
    categoryTags: ["poolVilla"],
    categoryConfidence: 0.5 + index / 200,
    categoryEvidence: [{ categoryKey: "poolVilla", source: "naver", reason: `근거 ${index}`, confidence: 0.5 + index / 200, observedAt: at }],
    observedAt: at
  })).company;
}
assert.equal(capped.categoryEvidence.length, MAX_EVIDENCE);

const mergedProfile = mergeCompanyCategoryProfiles(appliedOnce.company, {
  primaryCategoryKey: "glamping",
  categoryTags: ["glamping", "caravan"],
  categoryConfidence: 0.9,
  categoryEvidence: [{ categoryKey: "glamping", source: "ddnayo", reason: "업체명에 글램핑 포함", confidence: 0.9, observedAt: at }],
  sourcePlatforms: ["ddnayo"]
});
assert.ok(mergedProfile.categoryTags.includes("glamping"));
assert.ok(mergedProfile.categoryTags.includes("caravan"));
assert.ok(mergedProfile.sourcePlatforms.includes("ddnayo"));

console.log("Lodging company identity fixture tests passed without network or company-master I/O");
