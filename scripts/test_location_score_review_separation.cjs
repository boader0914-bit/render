"use strict";

const assert = require("node:assert/strict");

let networkCalls = 0;
global.fetch = async (url) => {
  networkCalls += 1;
  throw new Error(`Network calls are forbidden in score/review separation fixture tests: ${url}`);
};

process.env.RENDER = "";
process.env.RENDER_SERVICE_NAME = "";
process.env.RENDER_EXTERNAL_HOSTNAME = "";
process.env.GLAMPING_B2B_ENABLED = "0";

const {
  __test: {
    adminRegionReviewMeta,
    applyAdminRegionReviewsToOperations,
    publicB2BRegionReviewSummary
  }
} = require("./glamping_app_server.cjs");

const REVIEW_STATUSES = ["public_ready", "review_needed", "collect_needed", "hold"];

function regionFixture(regionKey, regionLabel, score = 61) {
  return {
    regionKey,
    regionLabel,
    provinceKey: "fixture",
    provinceLabel: "Fixture Province",
    localityKey: regionKey,
    localityLabel: regionLabel,
    level: "local",
    status: {
      key: "review_needed",
      label: "Derived readiness",
      score
    },
    locationScore: {
      modelVersion: "fixture-attractiveness-v1",
      computedScore: 47,
      publishedScore: 47
    },
    attractiveness: {
      score: 47,
      demand: 52,
      access: 44
    },
    dataQuality: {
      grade: "C",
      score: 54,
      reasons: ["fixture_partial_coverage"]
    },
    preflight: {
      status: { key: "review", label: "Data review", tone: "watch" },
      readinessScore: 52,
      coverage: 0.625
    },
    maintenance: {
      readinessScore: 52,
      maintenancePriority: 73,
      nextCycle: "data-derived-cycle",
      coverage: 0.625
    }
  };
}

function reviewFixture(region, status, suffix = "") {
  return {
    regionKey: region.regionKey,
    regionLabel: region.regionLabel,
    provinceLabel: region.provinceLabel,
    status,
    note: `internal review note ${suffix}`.trim(),
    checklistSummary: "fixture checklist",
    updatedBy: "fixture-admin",
    updatedAt: "2026-08-05T00:00:00.000Z"
  };
}

function decisionNumbers(region) {
  return {
    status: region.status,
    locationScore: region.locationScore,
    attractiveness: region.attractiveness,
    dataQuality: region.dataQuality,
    preflight: region.preflight,
    maintenance: region.maintenance
  };
}

function operationsFixture(regions) {
  return {
    schemaVersion: 2,
    regions,
    summary: {
      regionCount: regions.length,
      publicReadyRegionCount: 1,
      preflightReadyRegionCount: 0,
      reviewNeededRegionCount: 1
    }
  };
}

function masterFixture(reviewRows) {
  return {
    regionReviews: Object.fromEntries(reviewRows.map((review) => [review.regionKey, review])),
    regionReviewHistory: reviewRows.map((review, index) => ({
      at: `2026-08-05T00:00:0${index}.000Z`,
      action: "save",
      regionKey: review.regionKey,
      regionLabel: review.regionLabel,
      provinceLabel: review.provinceLabel,
      status: review.status,
      by: "fixture-admin"
    }))
  };
}

function assertReviewCannotChangeDecisionNumbers() {
  const baseRegion = regionFixture("fixture-alpha", "Alpha Region");
  const baseOps = operationsFixture([baseRegion]);
  const beforeRegion = decisionNumbers(baseRegion);
  const beforeSummary = { ...baseOps.summary };
  const serializedBefore = JSON.stringify(baseOps);

  for (const status of REVIEW_STATUSES) {
    const meta = adminRegionReviewMeta(status);
    assert.ok(meta, `review metadata must exist for ${status}`);
    assert.equal("scoreFloor" in meta, false, `${status} must not define a score floor`);
    assert.equal("scoreCap" in meta, false, `${status} must not define a score cap`);
    assert.equal("statusKey" in meta, false, `${status} must not replace the derived status key`);

    const review = reviewFixture(baseRegion, status, status);
    const reviewed = applyAdminRegionReviewsToOperations(baseOps, masterFixture([review]));
    const reviewedRegion = reviewed.regions[0];

    assert.deepEqual(
      decisionNumbers(reviewedRegion),
      beforeRegion,
      `${status} must not change attractiveness, quality, readiness, or maintenance values`
    );
    assert.equal(reviewedRegion.reviewWorkflowStatus.key, status);
    assert.equal(reviewedRegion.adminReview.status, status);
    assert.equal(reviewedRegion.adminReviewHistory.length, 1);
    assert.equal(reviewedRegion.nextReviewCycle, meta.nextCycle);
    assert.equal(reviewed.summary.publicReadyRegionCount, beforeSummary.publicReadyRegionCount);
    assert.equal(reviewed.summary.preflightReadyRegionCount, beforeSummary.preflightReadyRegionCount);
    assert.equal(JSON.stringify(baseOps), serializedBefore, "review projection must not mutate its input operations document");
  }
}

function assertB2BReviewRequiresExactRegionCandidate() {
  const alpha = regionFixture("fixture-alpha", "Alpha Region", 83);
  const beta = regionFixture("fixture-beta", "Beta Region", 42);
  const ops = operationsFixture([alpha, beta]);
  const master = masterFixture([
    reviewFixture(alpha, "public_ready", "alpha"),
    reviewFixture(beta, "review_needed", "beta")
  ]);

  const exact = publicB2BRegionReviewSummary({
    run: { keyword: "Unrelated Search" },
    regions: [{ region: "Beta Region" }],
    adminRegionalOperations: ops
  }, master);
  assert.equal(exact.regionKey, "fixture-beta", "an exact candidate must select only its reviewed region");
  assert.equal(exact.status, "review_needed");

  const unmatched = publicB2BRegionReviewSummary({
    run: { keyword: "Gamma Region" },
    regions: [{ region: "Gamma Region" }],
    adminRegionalOperations: ops
  }, master);
  assert.equal(
    unmatched,
    null,
    "an unmatched candidate must not fall back to another public-ready or first reviewed region"
  );

  const missingCandidate = publicB2BRegionReviewSummary({
    run: {},
    regions: [],
    adminRegionalOperations: ops
  }, master);
  assert.equal(missingCandidate, null, "missing region context must not select an arbitrary reviewed region");
}

function assertSameNameRegionsRequireQualifiedMatch() {
  const gangwonGoseong = {
    ...regionFixture("gangwon:goseong", "Goseong County", 77),
    provinceKey: "gangwon",
    provinceLabel: "Gangwon Province",
    localityKey: "goseong",
    localityLabel: "Goseong County"
  };
  const gyeongnamGoseong = {
    ...regionFixture("gyeongnam:goseong", "Goseong County", 64),
    provinceKey: "gyeongnam",
    provinceLabel: "Gyeongnam Province",
    localityKey: "goseong",
    localityLabel: "Goseong County"
  };
  const ops = operationsFixture([gangwonGoseong, gyeongnamGoseong]);
  const gangwonReview = {
    ...reviewFixture(gangwonGoseong, "public_ready", "gangwon-goseong"),
    regionKey: ""
  };
  const master = {
    regionReviews: { "manual-gangwon-goseong-review": gangwonReview },
    regionReviewHistory: [{
      at: "2026-08-05T00:00:00.000Z",
      action: "save",
      regionKey: "",
      regionLabel: gangwonReview.regionLabel,
      provinceLabel: gangwonReview.provinceLabel,
      status: gangwonReview.status,
      by: "fixture-admin"
    }]
  };
  const reviewed = applyAdminRegionReviewsToOperations(ops, master);
  const reviewedGangwon = reviewed.regions.find((region) => region.regionKey === gangwonGoseong.regionKey);
  const untouchedGyeongnam = reviewed.regions.find((region) => region.regionKey === gyeongnamGoseong.regionKey);

  assert.equal(
    reviewedGangwon.adminReview?.provinceLabel,
    gangwonGoseong.provinceLabel,
    "an exact province-and-label composite must match even without a stored region key"
  );
  assert.equal(reviewedGangwon.adminReviewHistory?.length, 1);
  assert.equal(
    Object.hasOwn(untouchedGyeongnam, "adminReview"),
    false,
    "a review must not cross-link to another province through an unqualified same-name label"
  );
  assert.equal(
    Object.hasOwn(untouchedGyeongnam, "adminReviewHistory"),
    false,
    "review history must not cross-link to another province through an unqualified same-name label"
  );
  assert.deepEqual(decisionNumbers(reviewedGangwon), decisionNumbers(gangwonGoseong));
  assert.deepEqual(decisionNumbers(untouchedGyeongnam), decisionNumbers(gyeongnamGoseong));

  const ambiguousLabel = publicB2BRegionReviewSummary({
    run: { keyword: "Goseong County" },
    regions: [],
    adminRegionalOperations: ops
  }, master);
  assert.equal(
    ambiguousLabel,
    null,
    "an unqualified same-name search must not select an arbitrary province's reviewed region"
  );

  const exactRegionKey = publicB2BRegionReviewSummary({
    run: { keyword: gangwonGoseong.regionKey },
    regions: [],
    adminRegionalOperations: ops
  }, master);
  assert.equal(
    exactRegionKey?.provinceLabel,
    gangwonGoseong.provinceLabel,
    "an exact operation region key must resolve its reviewed region"
  );
}

function assertCanonicalAmbiguitySurvivesPartialOperationFixtures() {
  const gangwonGoseong = {
    ...regionFixture("gangwon:고성", "고성", 71),
    provinceKey: "gangwon",
    provinceLabel: "강원",
    localityKey: "고성",
    localityLabel: "고성"
  };
  const review = reviewFixture(gangwonGoseong, "public_ready", "canonical-ambiguity");
  const ops = operationsFixture([gangwonGoseong]);
  const master = masterFixture([review]);

  const unqualified = publicB2BRegionReviewSummary({
    run: { keyword: "고성" },
    regions: [],
    adminRegionalOperations: ops
  }, master);
  assert.equal(
    unqualified,
    null,
    "a globally ambiguous canonical alias must remain unmatched even when only one operation region is loaded"
  );

  const qualified = publicB2BRegionReviewSummary({
    run: { keyword: "고성", provinceLabel: "강원" },
    regions: [],
    adminRegionalOperations: ops
  }, master);
  assert.equal(qualified?.regionKey, gangwonGoseong.regionKey);
  assert.equal(qualified?.provinceLabel, gangwonGoseong.provinceLabel);
}

assertReviewCannotChangeDecisionNumbers();
assertB2BReviewRequiresExactRegionCandidate();
assertSameNameRegionsRequireQualifiedMatch();
assertCanonicalAmbiguitySurvivesPartialOperationFixtures();
assert.equal(networkCalls, 0, "score/review separation fixtures must not call the network");

console.log("Location score/review separation and exact B2B region matching tests passed");
