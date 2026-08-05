"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  LocationReferenceCrosswalkError,
  resolveReferenceRegionKey,
  validateLocationReferenceCrosswalk
} = require("./location_reference_crosswalk.cjs");

const guard = installFixtureNetworkGuard({ label: "location reference crosswalk fixtures" });

try {
  const canonicalRegistry = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "web", "data", "location_region_registry.json"),
    "utf8"
  ));
  const allowedRegionKeys = new Set(
    canonicalRegistry.regions.filter((region) => region.active === true).map((region) => region.regionKey)
  );
  const syntheticFixture = {
    schemaVersion: "location-reference-crosswalk.v1",
    registryVersion: "synthetic-fixture-2026-08-05.v1",
    primaryRegionField: "regionKey",
    usageRole: "canonical_crosswalk",
    records: [
      {
        regionKey: "kr_gyeonggi_pocheon",
        sidoCode: "11",
        sigunguCode: "11111",
        legalDongCodes: ["1111100000", "1111111111"],
        validFrom: "2026-01-01",
        validTo: null,
        sourceRef: { datasetId: "fixture:synthetic-legal-dong", version: "fixture-v1" },
        status: "verified"
      },
      {
        regionKey: "kr_gyeongnam_sancheong",
        sidoCode: "22",
        sigunguCode: "22222",
        legalDongCodes: ["2222200000"],
        validFrom: "2026-01-01",
        validTo: null,
        sourceRef: { datasetId: "fixture:synthetic-legal-dong", version: "fixture-v1" },
        status: "verified"
      },
      {
        regionKey: "kr_gyeongnam_hadong",
        sidoCode: "33",
        sigunguCode: "33333",
        legalDongCodes: ["3333300000"],
        validFrom: "2025-01-01",
        validTo: "2025-12-31",
        sourceRef: { datasetId: "fixture:synthetic-legal-dong", version: "fixture-v1" },
        status: "verified"
      }
    ]
  };
  const before = JSON.stringify(syntheticFixture);

  assert.equal(
    validateLocationReferenceCrosswalk(syntheticFixture, { allowedRegionKeys }),
    syntheticFixture
  );
  assert.equal(new Set(syntheticFixture.records.map((record) => record.regionKey)).size, syntheticFixture.records.length);
  assert.equal(syntheticFixture.primaryRegionField, "regionKey");

  assert.equal(resolveReferenceRegionKey(syntheticFixture, {
    regionKey: "kr_gyeonggi_pocheon",
    asOf: "2026-08-05"
  }, { allowedRegionKeys }), "kr_gyeonggi_pocheon");
  assert.equal(resolveReferenceRegionKey(syntheticFixture, {
    legalDongCode10: "1111100000",
    asOf: "2026-08-05"
  }, { allowedRegionKeys }), "kr_gyeonggi_pocheon");
  assert.equal(resolveReferenceRegionKey(syntheticFixture, {
    regionKey: "kr_gyeonggi_pocheon",
    legalDongCode10: "1111111111",
    asOf: "2026-08-05"
  }, { allowedRegionKeys }), "kr_gyeonggi_pocheon");

  assert.equal(resolveReferenceRegionKey(syntheticFixture, {
    regionKey: "kr_gyeonggi_pocheon",
    legalDongCode10: "2222200000",
    asOf: "2026-08-05"
  }, { allowedRegionKeys }), null, "a conflicting legal code must not override regionKey");
  assert.equal(resolveReferenceRegionKey(syntheticFixture, {
    regionKey: "kr_unknown_missing",
    legalDongCode10: "1111100000",
    asOf: "2026-08-05"
  }, { allowedRegionKeys }), null, "an unknown primary regionKey must not fall through to a legal code");
  assert.equal(resolveReferenceRegionKey(syntheticFixture, {
    legalDongCode10: "9999900000",
    asOf: "2026-08-05"
  }, { allowedRegionKeys }), null, "unmatched legal code must remain null");
  assert.equal(resolveReferenceRegionKey(syntheticFixture, {
    legalDongCode10: "1111100001",
    asOf: "2026-08-05"
  }, { allowedRegionKeys }), null, "a similar legal code must not fuzzy-match or select the first region");
  assert.equal(resolveReferenceRegionKey(syntheticFixture, {
    sido: "경기도",
    sigungu: "포천시",
    asOf: "2026-08-05"
  }, { allowedRegionKeys }), null, "names are not selectors in the optional legal-dong crosswalk");
  assert.equal(resolveReferenceRegionKey(syntheticFixture, {
    legalDongCode10: "3333300000",
    asOf: "2026-08-05"
  }, { allowedRegionKeys }), null, "expired reference records must not match");
  assert.equal(resolveReferenceRegionKey(syntheticFixture, {
    legalDongCode10: "3333300000",
    asOf: "2025-06-01"
  }, { allowedRegionKeys }), "kr_gyeongnam_hadong");
  assert.equal(resolveReferenceRegionKey(syntheticFixture, {
    legalDongCode10: "invalid",
    asOf: "2026-08-05"
  }, { allowedRegionKeys }), null);
  assert.equal(resolveReferenceRegionKey(syntheticFixture, {
    legalDongCode10: "1111100000",
    asOf: "not-a-date"
  }, { allowedRegionKeys }), null);
  assert.equal(JSON.stringify(syntheticFixture), before, "validation and resolution must not mutate the fixture");

  const duplicateCode = structuredClone(syntheticFixture);
  duplicateCode.records[1].legalDongCodes = ["1111100000"];
  assert.throws(
    () => validateLocationReferenceCrosswalk(duplicateCode, { allowedRegionKeys }),
    (error) => error instanceof LocationReferenceCrosswalkError
      && error.code === "INVALID_LOCATION_REFERENCE_CROSSWALK"
      && error.details.some((detail) => /multiple regionKeys/.test(detail))
  );

  const duplicateRegionKey = structuredClone(syntheticFixture);
  duplicateRegionKey.records[1].regionKey = "kr_gyeonggi_pocheon";
  assert.throws(
    () => validateLocationReferenceCrosswalk(duplicateRegionKey, { allowedRegionKeys }),
    (error) => error instanceof LocationReferenceCrosswalkError
      && error.details.some((detail) => /regionKey is duplicated/.test(detail))
  );

  const nonCanonicalRegion = structuredClone(syntheticFixture);
  nonCanonicalRegion.records[0].regionKey = "kr_fixture_not_canonical";
  assert.throws(
    () => validateLocationReferenceCrosswalk(nonCanonicalRegion, { allowedRegionKeys }),
    (error) => error instanceof LocationReferenceCrosswalkError
      && error.details.some((detail) => /regionKey is not canonical/.test(detail))
  );

  assert.equal(guard.blockedAttempts(), 0);
  console.log("Location reference crosswalk contract passed (synthetic fixture only, no fallback)");
} finally {
  guard.restore();
}
