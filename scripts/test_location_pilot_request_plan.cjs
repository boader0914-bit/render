"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "location pilot request plan fixtures" });

try {
  const {
    PILOT_REGION_KEYS,
    buildPilotRequestPlan,
    previousClosedMonth
  } = require("./location_pilot_request_plan.cjs");

  assert.deepEqual(previousClosedMonth(new Date("2026-08-05T00:00:00.000Z")), {
    from: "2026-07-01",
    to: "2026-07-31"
  });
  assert.deepEqual(previousClosedMonth(new Date("2026-07-31T15:30:00.000Z")), {
    from: "2026-07-01",
    to: "2026-07-31"
  }, "the default planning month must use the Seoul calendar at a UTC month boundary");

  const plan = buildPilotRequestPlan({
    measurementPeriod: { from: "2026-07-01", to: "2026-07-31" },
    plannedAt: "2026-08-05T09:00:00.000Z"
  });

  assert.equal(plan.schemaVersion, "location-api-pilot-request-plan.v1");
  assert.equal(plan.mode, "sanitized-fixture-only");
  assert.equal(plan.actualCallsEnabled, false);
  assert.equal(plan.plannedCallCount, 0);
  assert.deepEqual(plan.pilotRegionKeys, [...PILOT_REGION_KEYS]);
  assert.equal(plan.sourceScope.apiSourceIds.length, 11);
  assert.equal(plan.sourceScope.selectedSourceIds.length, 6);
  assert.equal(plan.sourceScope.candidateSourceIds.length, 5);
  assert.deepEqual(plan.sourceScope.referenceOnlySourceIds, ["mois.legal_dong.reference"]);

  assert.equal(plan.referenceSources.length, 1);
  assert.equal(plan.referenceSources[0].sourceId, "mois.legal_dong.reference");
  assert.equal(plan.referenceSources[0].connectionStage, "reference_only");
  assert.equal(plan.referenceSources[0].repeatedCollectionPlanned, false);
  assert.equal(plan.referenceSources[0].apiConnectionRequired, false);

  assert.equal(plan.sharedCollections.length, 1);
  const sharedCamping = plan.sharedCollections[0];
  assert.equal(sharedCamping.sourceId, "kto.gocamping.inventory");
  assert.equal(sharedCamping.requestScope, "national_shared_snapshot");
  assert.deepEqual(sharedCamping.targetRegionKeys, [...PILOT_REGION_KEYS]);
  assert.equal(sharedCamping.postFilter.mode, "exact");
  assert.equal(sharedCamping.postFilter.fuzzyFallback, false);
  assert.equal(sharedCamping.plannedCallCount, 0);
  assert.equal(sharedCamping.estimatedPageCount, null);
  assert.equal(sharedCamping.estimatedCallCount, null);
  assert.equal(sharedCamping.descriptor.regionSelection.targetRegions.length, 3);

  assert.equal(plan.regions.length, 3);
  for (const regionPlan of plan.regions) {
    assert.equal(PILOT_REGION_KEYS.includes(regionPlan.regionKey), true);
    assert.equal(regionPlan.canonicalMatch, "exact");
    assert.equal(regionPlan.fuzzyFallback, false);
    const ktoIdentifier = regionPlan.officialSigunguIdentifiers.find((identifier) => identifier.codeSystem === "KTO_DATALAB_SGG_CD");
    const tourApiIdentifier = regionPlan.officialSigunguIdentifiers.find((identifier) => identifier.codeSystem === "TOUR_API_AREA_SIGUNGU");
    assert.match(ktoIdentifier.value, /^\d{5}$/);
    assert.equal(ktoIdentifier.status, "mapped");
    assert.equal(tourApiIdentifier.value, null, "unverified TourAPI codes must not be invented");
    assert.equal(tourApiIdentifier.status, "unverified");
    assert.equal(regionPlan.optionalCrosswalk.sourceId, "mois.legal_dong.reference");
    assert.equal(regionPlan.optionalCrosswalk.requiredForSigunguPlan, false);
    assert.equal(regionPlan.optionalCrosswalk.codeIncluded, false);
    assert.equal(Object.hasOwn(regionPlan.optionalCrosswalk, "legalDongCode10"), false);
    assert.equal(regionPlan.sources.length, 11);

    const campingPlan = regionPlan.sources.find((source) => source.sourceId === "kto.gocamping.inventory");
    assert.equal(campingPlan.sharedCollectionKey, sharedCamping.sharedCollectionKey);
    assert.equal(campingPlan.descriptor, null, "the shared national snapshot must not be duplicated per region");

    for (const sourcePlan of regionPlan.sources) {
      assert.equal(sourcePlan.regionKey, regionPlan.regionKey);
      assert.match(sourcePlan.operation, /^[A-Za-z][A-Za-z0-9]*$/);
      assert.equal(sourcePlan.actualCallsEnabled, false);
      assert.equal(sourcePlan.plannedCallCount, 0);
      assert.equal(sourcePlan.estimatedPageCount, null);
      assert.equal(sourcePlan.estimatedCallCount, null);
      assert.equal(sourcePlan.approvalRequired, true);
      assert.ok(sourcePlan.pageCeiling >= 1);
      assert.ok(sourcePlan.callCeiling >= 1);
      if (sourcePlan.descriptor) assert.equal(sourcePlan.descriptor.actualCallsEnabled, false);
    }

    for (const sourceId of ["kto.tour_info.resources", "kto.tour_info.events", "kto.tour_info.lodging"]) {
      const sourcePlan = regionPlan.sources.find((source) => source.sourceId === sourceId);
      assert.equal(sourcePlan.descriptor.regionSelection.requestRegionParametersIncluded, false);
      assert.ok(sourcePlan.blockers.includes("tourapi_region_code_crosswalk_unverified"));
      assert.equal(Object.hasOwn(sourcePlan.descriptor.parameters, "areaCode"), false);
      assert.equal(Object.hasOwn(sourcePlan.descriptor.parameters, "sigunguCode"), false);
    }
  }

  assert.equal(plan.summary.pilotRegionCount, 3);
  assert.equal(plan.summary.apiSourceCount, 11);
  assert.equal(plan.summary.sourcePlanCount, 33);
  assert.equal(plan.summary.uniqueRequestDescriptorCount, 31, "one GoCamping descriptor must be shared across all pilot regions");
  assert.equal(plan.summary.enabledRequestDescriptorCount, 0);
  assert.equal(plan.summary.repeatedReferenceCollectionCount, 0);
  assert.equal(plan.summary.estimatedPageCount, null);
  assert.equal(plan.summary.estimatedCallCount, null);

  const serialized = JSON.stringify(plan);
  assert.doesNotMatch(serialized, /"(?:serviceKey|apiKey|clientSecret|secretKey|signature|authorization|token|customerId)"\s*:/i);
  assert.doesNotMatch(serialized, /"(?:X-Naver-Client-Id|X-Naver-Client-Secret|X-API-KEY|X-Customer|X-Signature|X-Timestamp)"\s*:/i);
  assert.doesNotMatch(serialized, /mois\.legal_dong\.reference[^}]*"descriptor"/i);

  const planSource = fs.readFileSync(path.join(__dirname, "location_pilot_request_plan.cjs"), "utf8");
  assert.doesNotMatch(planSource, /process\.env/);
  assert.equal(networkGuard.blockedAttempts(), 0);
  assert.equal(Object.isFrozen(plan), true);
  console.log(`Location pilot request plan fixtures passed (${plan.summary.uniqueRequestDescriptorCount} unique descriptors, network disabled)`);
} finally {
  networkGuard.restore();
}
