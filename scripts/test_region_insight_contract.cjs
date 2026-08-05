"use strict";

const assert = require("node:assert/strict");

let networkCalls = 0;
global.fetch = async (url) => {
  networkCalls += 1;
  throw new Error(`Network calls are forbidden in fixture-only contract tests: ${url}`);
};

const {
  CONTRACT_VERSION,
  RegionInsightContractError,
  buildRegionInsightState,
  computeRegionDraftHash,
  createPublicationSnapshot,
  hashDraftPayload,
  normalizeRegionInsightState,
  publishRegionInsightState,
  toPublicRegionInsight,
  validateRegionInsightState
} = require("./region_insight_contract.cjs");

function fixture(overrides = {}) {
  const base = {
    regionKey: "kr_gyeonggi_pocheon",
    locationAttractiveness: {
      value: 74,
      modelVersion: "location-attractiveness.v1",
      components: [
        { key: "natural_resources", value: 82, weight: 0.4, evidenceIds: ["forest-1"] },
        { key: "market_demand", value: 68, weight: 0.6, evidenceIds: ["demand-1"] }
      ]
    },
    dataQuality: {
      status: "partial",
      score: 81,
      grade: "B",
      penalties: [
        { code: "ota_sample_partial", message: "OTA sample 4/18 properties", points: 8 }
      ],
      coverage: { numerator: 14, denominator: 18, note: "14 of 18 expected sources" },
      freshness: {
        status: "fresh",
        asOf: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-04T12:00:00.000Z",
        ageDays: 0.5
      }
    },
    review: {
      status: "draft",
      reviewedDraftHash: "",
      reviewedAt: "",
      reviewer: { id: "", displayName: "" },
      adminMemo: "internal draft note"
    },
    publication: {
      status: "unpublished",
      publicationId: "",
      version: "",
      publishedAt: "",
      adminMemo: "internal publication note"
    }
  };
  const merged = {
    ...base,
    ...overrides,
    locationAttractiveness: {
      ...base.locationAttractiveness,
      ...(overrides.locationAttractiveness || {})
    },
    dataQuality: {
      ...base.dataQuality,
      ...(overrides.dataQuality || {}),
      coverage: {
        ...base.dataQuality.coverage,
        ...(overrides.dataQuality?.coverage || {})
      },
      freshness: {
        ...base.dataQuality.freshness,
        ...(overrides.dataQuality?.freshness || {})
      }
    },
    review: { ...base.review, ...(overrides.review || {}) },
    publication: { ...base.publication, ...(overrides.publication || {}) }
  };
  return {
    ...merged,
    draftHash: Object.prototype.hasOwnProperty.call(overrides, "draftHash")
      ? overrides.draftHash
      : computeRegionDraftHash(
          merged.regionKey,
          merged.locationAttractiveness,
          merged.dataQuality
        )
  };
}

function assertContractError(action, code) {
  assert.throws(
    action,
    (error) => error instanceof RegionInsightContractError
      && error.errors.some((entry) => entry.code === code),
    `expected RegionInsightContractError containing ${code}`
  );
}

function main() {
  assert.equal(CONTRACT_VERSION, "region-insight.state.v1");
  assert.equal(
    hashDraftPayload({ b: 2, a: 1 }),
    hashDraftPayload({ a: 1, b: 2 }),
    "draft payload hashing must be deterministic"
  );

  const draft = buildRegionInsightState(fixture());
  assert.equal(toPublicRegionInsight(draft), null, "unpublished drafts must not produce a business-facing projection");
  assertContractError(
    () => createPublicationSnapshot(draft, {
      publicationId: "invalid-draft-v1",
      version: "1",
      publishedAt: "2026-08-05T02:00:00.000Z"
    }),
    "publication_requires_review"
  );

  const reviewedDraft = buildRegionInsightState(fixture({
    review: {
      status: "reviewed",
      reviewedDraftHash: draft.draftHash,
      reviewedAt: "2026-08-05T01:00:00.000Z",
      reviewer: { id: "admin-17", displayName: "Regional reviewer" },
      adminMemo: "approved after evidence review"
    }
  }));
  const publicationMetadata = {
    publicationId: "pocheon-v1",
    version: "1",
    publishedAt: "2026-08-05T02:00:00.000Z",
    adminMemo: "internal release note"
  };
  const createdSnapshot = createPublicationSnapshot(reviewedDraft, publicationMetadata);
  const repeatedSnapshot = createPublicationSnapshot(reviewedDraft, publicationMetadata);
  assert.equal(createdSnapshot.snapshotHash, repeatedSnapshot.snapshotHash, "snapshot hashing must be deterministic");
  assert.equal(Object.isFrozen(createdSnapshot), true);
  assert.equal(Object.isFrozen(createdSnapshot.locationAttractiveness), true);

  const published = publishRegionInsightState(reviewedDraft, publicationMetadata);
  assert.deepEqual(
    published.locationAttractiveness,
    draft.locationAttractiveness,
    "review and publication state must not change attractiveness"
  );
  assert.deepEqual(
    published.dataQuality,
    draft.dataQuality,
    "review and publication state must not change data quality"
  );
  assert.equal(Object.isFrozen(published), true);
  assert.equal(Object.isFrozen(published.dataQuality.penalties), true);
  assert.equal(Object.isFrozen(published.publication.snapshot), true);
  assert.deepEqual(published.publication.snapshot.locationAttractiveness, reviewedDraft.locationAttractiveness);
  assert.deepEqual(published.publication.snapshot.dataQuality, reviewedDraft.dataQuality);
  assert.equal(published.publication.snapshot.reviewedDraftHash, draft.draftHash);

  const missing = buildRegionInsightState(fixture({
    locationAttractiveness: {
      value: null,
      components: [{ key: "market_demand", value: null, weight: 1, evidenceIds: [] }]
    },
    dataQuality: {
      status: "missing",
      score: 50,
      grade: "C",
      penalties: [{ code: "source_not_collected", message: "SNS source not collected", points: null }],
      coverage: { numerator: 0, denominator: 18 },
      freshness: { status: "unknown", asOf: "", updatedAt: "", ageDays: null }
    }
  }));
  assert.equal(missing.locationAttractiveness.value, null);
  assert.equal(missing.locationAttractiveness.components[0].value, null);
  assert.equal(missing.dataQuality.score, null, "missing quality must never become a neutral score such as 50");
  assert.equal(missing.dataQuality.grade, "U");

  assertContractError(
    () => buildRegionInsightState(fixture({ review: { status: "approved" } })),
    "invalid_status"
  );
  assertContractError(
    () => buildRegionInsightState(fixture({ publication: { status: "live" } })),
    "invalid_status"
  );
  assertContractError(
    () => buildRegionInsightState(fixture({
      review: { status: "draft" },
      publication: {
        status: "published",
        publicationId: "invalid-v1",
        version: "1",
        publishedAt: "2026-08-05T02:00:00.000Z"
      }
    })),
    "publication_requires_review"
  );
  const invalidMissingQuality = {
    ...missing,
    dataQuality: { ...missing.dataQuality, score: 50 }
  };
  const invalidMissingResult = validateRegionInsightState(invalidMissingQuality);
  assert.equal(invalidMissingResult.valid, false);
  assert.equal(
    invalidMissingResult.errors.some((entry) => entry.code === "missing_score_must_be_null"),
    true
  );

  const contentTamperedWithOldHash = {
    ...reviewedDraft,
    draftHash: reviewedDraft.draftHash,
    locationAttractiveness: {
      ...reviewedDraft.locationAttractiveness,
      value: 12,
      components: reviewedDraft.locationAttractiveness.components.map((component) => ({ ...component }))
    }
  };
  assertContractError(
    () => buildRegionInsightState(contentTamperedWithOldHash),
    "draft_hash_mismatch"
  );
  assertContractError(
    () => createPublicationSnapshot(contentTamperedWithOldHash, publicationMetadata),
    "draft_hash_mismatch"
  );

  const changedAttractiveness = {
    ...published.locationAttractiveness,
    value: 29,
    components: published.locationAttractiveness.components.map((component) => ({ ...component }))
  };
  const changedDataQuality = {
    ...published.dataQuality,
    score: 63,
    grade: "C",
    penalties: published.dataQuality.penalties.map((penalty) => ({ ...penalty })),
    coverage: { ...published.dataQuality.coverage },
    freshness: { ...published.dataQuality.freshness }
  };
  const changedDraftHash = computeRegionDraftHash(
    published.regionKey,
    changedAttractiveness,
    changedDataQuality
  );
  assert.notEqual(changedDraftHash, published.draftHash, "a normal content change must produce a new deterministic draft hash");
  const changedDraft = normalizeRegionInsightState({
    ...published,
    draftHash: changedDraftHash,
    locationAttractiveness: changedAttractiveness,
    dataQuality: changedDataQuality,
    review: published.review,
    publication: published.publication
  });
  assert.equal(changedDraft.review.status, "review_required", "a changed draft must require a new review");
  assert.equal(changedDraft.publication.status, "stale", "the prior publication must become stale after the draft changes");
  assert.equal(changedDraft.review.reviewedDraftHash, published.draftHash, "historical review hash remains auditable internally");
  assert.equal(changedDraft.locationAttractiveness.value, 29, "the mutable current draft may change independently");
  assert.equal(changedDraft.dataQuality.score, 63, "the mutable current quality may change independently");
  assert.deepEqual(changedDraft.publication.snapshot, published.publication.snapshot, "the prior immutable snapshot must be preserved");
  assert.equal(validateRegionInsightState(changedDraft).valid, true);

  const stalePublicProjection = toPublicRegionInsight(changedDraft);
  assert.equal(stalePublicProjection.publication.status, "stale");
  assert.equal(stalePublicProjection.locationAttractiveness.value, 74, "stale public output must retain the published attractiveness");
  assert.equal(stalePublicProjection.dataQuality.score, 81, "stale public output must retain the published quality score");
  assert.notEqual(stalePublicProjection.locationAttractiveness.value, changedDraft.locationAttractiveness.value);
  assert.notEqual(stalePublicProjection.dataQuality.score, changedDraft.dataQuality.score);

  const tamperedSnapshot = {
    ...published,
    publication: {
      ...published.publication,
      snapshot: {
        ...published.publication.snapshot,
        locationAttractiveness: {
          ...published.publication.snapshot.locationAttractiveness,
          value: 1
        }
      }
    }
  };
  assertContractError(() => buildRegionInsightState(tamperedSnapshot), "snapshot_hash_mismatch");

  const publicProjection = toPublicRegionInsight(published);
  const publicJson = JSON.stringify(publicProjection);
  assert.equal("review" in publicProjection, false);
  assert.equal("draftHash" in publicProjection, false);
  assert.equal("snapshot" in publicProjection.publication, false);
  assert.equal("adminMemo" in publicProjection.publication, false);
  assert.equal(publicJson.includes(published.draftHash), false);
  assert.equal(publicJson.includes(published.publication.snapshot.snapshotHash), false);
  assert.equal(publicJson.includes("admin-17"), false);
  assert.equal(publicJson.includes("Regional reviewer"), false);
  assert.equal(publicJson.includes("approved after evidence review"), false);
  assert.equal(publicJson.includes("internal release note"), false);
  assert.deepEqual(publicProjection.locationAttractiveness, published.publication.snapshot.locationAttractiveness);
  assert.deepEqual(publicProjection.dataQuality, published.publication.snapshot.dataQuality);

  assert.equal(networkCalls, 0, "fixture-only tests must not call the network");
  console.log("Region insight state contract fixture tests passed.");
}

main();
