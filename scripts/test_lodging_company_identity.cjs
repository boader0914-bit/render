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

const coordinateObservation = standardizeCompanyObservation({
  sourcePlatform: "nol",
  sourceId: "nol-coordinate",
  name: baseCompany.primaryName,
  address: baseCompany.addresses[0],
  region: baseCompany.regions[0],
  latitude: 35.5001,
  longitude: 128.1001,
  observedAt: at
});
const outsideServiceCoordinate = standardizeCompanyObservation({
  sourcePlatform: "nol",
  sourceId: "nol-outside-service-area",
  name: baseCompany.primaryName,
  address: baseCompany.addresses[0],
  region: baseCompany.regions[0],
  latitude: 37.7749,
  longitude: -122.4194,
  observedAt: at
});
assert.equal(outsideServiceCoordinate.location, null);
assert.equal(outsideServiceCoordinate.latitude, null);
assert.equal(outsideServiceCoordinate.longitude, null);
const outsideApplied = applyObservationToCompany(baseCompany, outsideServiceCoordinate).company;
assert.equal((outsideApplied.coordinates || []).length, 0, "coordinates rejected by the shared Korea service boundary must not be resurrected by identity storage");

const manualLocationCompany = {
  ...baseCompany,
  manualCorrection: {
    active: true,
    location: {
      latitude: 37.9001,
      longitude: 127.2001,
      status: "verified",
      source: "manual"
    }
  },
  location: {
    latitude: 37.9001,
    longitude: 127.2001,
    status: "verified",
    source: "manual"
  }
};
const manualLocationApplied = applyObservationToCompany(manualLocationCompany, coordinateObservation).company;
assert.equal(manualLocationApplied.manualCorrection.location.source, "manual");
assert.equal(manualLocationApplied.location.source, "provider", "an active manual correction must not be mirrored into the automatic top-level location projection");
const farAutomaticObservation = standardizeCompanyObservation({
  sourcePlatform: "naver",
  sourceId: "far-automatic-coordinate",
  name: baseCompany.primaryName,
  address: baseCompany.addresses[0],
  region: baseCompany.regions[0],
  latitude: 35.82,
  longitude: 128.42,
  observedAt: "2026-07-31T10:00:00.000Z"
});
const automaticThenManual = {
  ...baseCompany,
  location: {
    latitude: 35.5001,
    longitude: 128.1001,
    status: "resolved",
    source: "provider",
    geocodedAt: "2026-07-29T00:00:00.000Z"
  },
  coordinates: [
    { latitude: 35.5001, longitude: 128.1001, status: "resolved", source: "provider", observedAt: "2026-07-29T00:00:00.000Z" },
    { latitude: 37.9002, longitude: 127.2002, status: "verified", source: "manual", observedAt: "2026-07-30T00:00:00.000Z" }
  ],
  manualCorrection: {
    active: true,
    location: { latitude: 37.9, longitude: 127.2, status: "verified", source: "manual" }
  }
};
const farAutomaticApplied = applyObservationToCompany(automaticThenManual, farAutomaticObservation).company;
assert.equal(farAutomaticApplied.location.latitude, 35.5001, "a far automatic candidate must not silently move the stored automatic marker");
assert.equal(farAutomaticApplied.location.source, "provider");
assert.equal(farAutomaticApplied.locationReview.status, "pending", "a rejected far automatic coordinate must create an explicit review state");
assert.equal(farAutomaticApplied.locationReview.reason, "automatic_coordinate_conflict");
assert.equal(farAutomaticApplied.manualCorrection.location.source, "manual");
const olderNearObservation = standardizeCompanyObservation({
  name: baseCompany.primaryName,
  address: baseCompany.addresses[0],
  region: baseCompany.regions[0],
  latitude: 35.5002,
  longitude: 128.1002,
  observedAt: "2025-01-01T00:00:00.000Z"
});
const afterOlderNearObservation = applyObservationToCompany(farAutomaticApplied, olderNearObservation).company;
assert.equal(afterOlderNearObservation.location.latitude, 35.5001, "an older lower-priority nearby point must not replace the current provider point");
assert.equal(afterOlderNearObservation.locationReview.reason, "automatic_coordinate_conflict", "an unrelated unaccepted observation must not erase a pending far-coordinate review");
const staleFirstCoordinateCompany = {
  ...baseCompany,
  coordinates: [
    { latitude: 37.5, longitude: 127.1, observedAt: "2026-07-01T00:00:00.000Z" },
    { latitude: 35.5002, longitude: 128.1002, observedAt: "2026-07-29T00:00:00.000Z" }
  ],
  location: {
    latitude: 35.5002,
    longitude: 128.1002,
    status: "resolved",
    source: "provider",
    resolvedAddress: baseCompany.addresses[0],
    geocodedAt: "2026-07-29T00:00:00.000Z"
  }
};
assert.equal(decideCompanyMatch(coordinateObservation, [staleFirstCoordinateCompany]).decision, "merge", "a stale first coordinate must not hide the latest effective company point");
const farCoordinateCompany = {
  ...baseCompany,
  coordinates: [{ latitude: 37.5, longitude: 127.1 }],
  location: {
    latitude: 37.5,
    longitude: 127.1,
    status: "resolved",
    source: "legacy",
    resolvedAddress: baseCompany.addresses[0]
  }
};
assert.equal(decideCompanyMatch(coordinateObservation, [farCoordinateCompany]).decision, "review", "exact name/address/region with a distant coordinate conflict must be reviewed rather than duplicated");

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
