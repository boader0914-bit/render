"use strict";

const assert = require("node:assert/strict");
let networkCalls = 0;
global.fetch = async (url) => {
  networkCalls += 1;
  throw new Error(`Network calls are forbidden in region matching fixture tests: ${url}`);
};
const {
  LocationRegionRegistryError,
  createLocationRegionMatcher,
  matchLocationRegion,
  readLocationRegionRegistry,
  validateLocationRegionRegistry
} = require("./location_region_matcher.cjs");

function main() {
  const registry = readLocationRegionRegistry();
  assert.equal(registry.registryVersion, "location-region-registry-v1.0.0");
  assert.equal(registry.active, true);
  assert.equal(registry.effectiveFrom, "2026-08-05");
  assert.equal(registry.effectiveTo, null);
  assert.equal(registry.regions.length, 48);
  assert.equal(registry.codeSystem.legalDongCode10, "MOIS_LEGAL_DONG_CODE_10");
  assert.equal(registry.codeSystem.ktoSggCd, "KTO_DATALAB_SGG_CD");
  for (const region of registry.regions) {
    assert.match(region.regionKey, /^kr_[a-z0-9_]+$/);
    assert.equal(region.legalDongCode10, null, "KTO codes must not be promoted to unverified legal-dong codes");
    assert.equal(region.legalDongCodeStatus, "unverified");
    assert.equal(region.legalDongCodeSource, null);
    assert.equal(region.legalDongCodeEffectiveFrom, null);
    if (region.ktoSggCdStatus === "unverified") {
      assert.equal(region.ktoSggCd, null);
      assert.equal(region.ktoSggCdSource, null);
      assert.equal(region.ktoSggCdEffectiveFrom, null);
      assert.equal(region.registryEntryStatus, "manual-ambiguity-seed-requires-code-verification");
    } else {
      assert.match(region.ktoSggCd, /^\d{5}$/);
      assert.ok(["mapped", "verify-before-api-call"].includes(region.ktoSggCdStatus));
      assert.equal(region.ktoSggCdSource.file, "web/data/tourism_region_map.json");
      assert.equal(region.ktoSggCdSource.version, "tourism-region-map-v0.1");
      assert.equal(region.ktoSggCdEffectiveFrom, "2026-07-09");
    }
    assert.equal(region.active, true);
    assert.match(region.effectiveFrom, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Array.isArray(region.aliases));
  }

  const match = createLocationRegionMatcher(registry);
  assert.equal(
    match({ regionKey: "kr_gyeonggi_pocheon" }).status,
    "matched",
    "the default registry date must use the Korea service calendar rather than the prior UTC date"
  );
  const byRegionKey = match({ regionKey: "kr_gyeonggi_pocheon", asOf: "2026-08-05" });
  assert.equal(byRegionKey.status, "matched");
  assert.equal(byRegionKey.reason, "region_key_exact");
  assert.equal(byRegionKey.region.regionKey, "kr_gyeonggi_pocheon");

  const unverifiedLegalCode = match({ legalDongCode10: "4885000000", asOf: "2026-08-05" });
  assert.equal(unverifiedLegalCode.status, "unmatched");
  assert.equal(unverifiedLegalCode.reason, "legal_dong_code_unmatched");

  const verifiedRegistry = structuredClone(registry);
  const verifiedPocheon = verifiedRegistry.regions.find((region) => region.regionKey === "kr_gyeonggi_pocheon");
  verifiedPocheon.legalDongCode10 = "4165000000";
  verifiedPocheon.legalDongCodeStatus = "verified";
  verifiedPocheon.legalDongCodeSource = {
    dataset: "fixture:mois-legal-dong",
    version: "fixture-v1"
  };
  verifiedPocheon.legalDongCodeEffectiveFrom = "2026-08-05";
  validateLocationRegionRegistry(verifiedRegistry);
  const verifiedMatch = createLocationRegionMatcher(verifiedRegistry);

  const byLegalCode = verifiedMatch({ legalDongCode10: "4165000000", asOf: "2026-08-05" });
  assert.equal(byLegalCode.status, "matched");
  assert.equal(byLegalCode.reason, "legal_dong_code_exact");
  assert.equal(byLegalCode.region.regionKey, "kr_gyeonggi_pocheon");

  const byLegalSigunguCode = verifiedMatch({ sigunguCode5: "41650", asOf: "2026-08-05" });
  assert.equal(byLegalSigunguCode.status, "matched");
  assert.equal(byLegalSigunguCode.reason, "legal_sigungu_code_exact");
  assert.equal(byLegalSigunguCode.region.regionKey, "kr_gyeonggi_pocheon");

  const byKtoSigunguCode = match({ ktoSggCd: "48860", asOf: "2026-08-05" });
  assert.equal(byKtoSigunguCode.status, "matched");
  assert.equal(byKtoSigunguCode.reason, "kto_sgg_code_exact");
  assert.equal(byKtoSigunguCode.region.regionKey, "kr_gyeongnam_sancheong");

  const byCanonicalNames = match({ sido: "경기도", sigungu: "포천시", asOf: "2026-08-05" });
  assert.equal(byCanonicalNames.status, "matched");
  assert.equal(byCanonicalNames.reason, "sido_sigungu_exact");
  assert.equal(byCanonicalNames.region.regionKey, "kr_gyeonggi_pocheon");

  const byStructuredAlias = match({ sido: "경남", keyword: "하동풀빌라", asOf: "2026-08-05" });
  assert.equal(byStructuredAlias.status, "matched");
  assert.equal(byStructuredAlias.reason, "sido_alias_exact");
  assert.equal(byStructuredAlias.region.regionKey, "kr_gyeongnam_hadong");

  const byQualifiedAlias = match({ keyword: "경상남도 하동풀빌라", asOf: "2026-08-05" });
  assert.equal(byQualifiedAlias.status, "matched");
  assert.equal(byQualifiedAlias.reason, "sido_alias_exact");
  assert.equal(byQualifiedAlias.region.regionKey, "kr_gyeongnam_hadong");

  const aliasWithoutSido = match({ keyword: "하동풀빌라", asOf: "2026-08-05" });
  assert.equal(aliasWithoutSido.status, "unmatched");
  assert.equal(aliasWithoutSido.reason, "sido_context_required");
  assert.equal(aliasWithoutSido.region, null);
  assert.deepEqual(aliasWithoutSido.candidates.map((row) => row.regionKey), ["kr_gyeongnam_hadong"]);

  const ambiguousGoseong = match({ keyword: "고성", asOf: "2026-08-05" });
  assert.equal(ambiguousGoseong.status, "ambiguous");
  assert.equal(ambiguousGoseong.reason, "alias_ambiguous");
  assert.equal(ambiguousGoseong.region, null);
  assert.deepEqual(
    ambiguousGoseong.candidates.map((row) => row.regionKey).sort(),
    ["kr_gangwon_goseong", "kr_gyeongnam_goseong"]
  );
  assert.ok(ambiguousGoseong.candidates.every((row) => row.ktoSggCd === null));

  const qualifiedGangwonGoseong = match({ keyword: "강원 고성", asOf: "2026-08-05" });
  assert.equal(qualifiedGangwonGoseong.status, "matched");
  assert.equal(qualifiedGangwonGoseong.region.regionKey, "kr_gangwon_goseong");

  const structuredGyeongnamGoseong = match({ sido: "경남", keyword: "고성", asOf: "2026-08-05" });
  assert.equal(structuredGyeongnamGoseong.status, "matched");
  assert.equal(structuredGyeongnamGoseong.region.regionKey, "kr_gyeongnam_goseong");

  const unknown = match({ keyword: "존재하지않는지역", asOf: "2026-08-05" });
  assert.equal(unknown.status, "unmatched");
  assert.equal(unknown.reason, "region_unmatched");
  assert.equal(unknown.region, null);

  const fuzzyForbidden = match({ keyword: "경기 포천글램핑추천", asOf: "2026-08-05" });
  assert.equal(fuzzyForbidden.status, "unmatched");
  assert.equal(fuzzyForbidden.reason, "region_unmatched");

  const wrongCaseKey = match({ regionKey: "KR_GYEONGGI_POCHEON", asOf: "2026-08-05" });
  assert.equal(wrongCaseKey.status, "unmatched");
  assert.equal(wrongCaseKey.reason, "region_key_unmatched");

  const conflictingSelectors = match({
    regionKey: "kr_gyeonggi_pocheon",
    ktoSggCd: "48850",
    asOf: "2026-08-05"
  });
  assert.equal(conflictingSelectors.status, "ambiguous");
  assert.equal(conflictingSelectors.reason, "exact_selector_conflict");
  assert.equal(conflictingSelectors.region, null);

  const beforeEffectiveDate = match({ regionKey: "kr_gyeonggi_pocheon", asOf: "2026-08-04" });
  assert.equal(beforeEffectiveDate.status, "unmatched");
  assert.equal(beforeEffectiveDate.reason, "registry_not_effective");

  const invalidRegistry = structuredClone(registry);
  invalidRegistry.regions[1].regionKey = invalidRegistry.regions[0].regionKey;
  assert.throws(
    () => validateLocationRegionRegistry(invalidRegistry),
    (error) => error instanceof LocationRegionRegistryError && error.details.some((detail) => detail.includes("duplicated"))
  );

  const unverifiableLegalRegistry = structuredClone(registry);
  const unverifiedPocheon = unverifiableLegalRegistry.regions.find((region) => region.regionKey === "kr_gyeonggi_pocheon");
  unverifiedPocheon.legalDongCode10 = "4165000000";
  unverifiedPocheon.legalDongCodeStatus = "verified";
  assert.throws(
    () => validateLocationRegionRegistry(unverifiableLegalRegistry),
    (error) => error instanceof LocationRegionRegistryError
      && error.details.some((detail) => detail.includes("legalDongCodeSource is required"))
  );

  const impossibleEffectiveDate = structuredClone(registry);
  impossibleEffectiveDate.effectiveFrom = "2026-02-31";
  assert.throws(
    () => validateLocationRegionRegistry(impossibleEffectiveDate),
    (error) => error instanceof LocationRegionRegistryError
      && error.details.some((detail) => detail.includes("effectiveFrom must be an ISO date"))
  );

  assert.equal(matchLocationRegion({ regionKey: "kr_gyeongnam_sancheong", asOf: "2026-08-05" }, registry).matched, true);
  assert.equal(networkCalls, 0, "region matching fixtures must not call the network");
  console.log("Location region registry and strict matching tests passed");
}

main();
