"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const registry = require("../web/data/location_region_registry.json");
const { createRegionInsightRuntime } = require("./region_insight_runtime.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "workflow revision fixtures" });

function draftPayload(value = 72) {
  return {
    locationAttractiveness: {
      value,
      modelVersion: "workflow-revision-fixture-v1",
      components: [{ key: "market_demand", value, weight: 1, evidenceIds: ["fixture-demand"] }]
    },
    dataQuality: {
      status: "partial",
      score: 78,
      grade: "B",
      penalties: [],
      coverage: { numerator: 14, denominator: 18, note: "fixture coverage" },
      freshness: {
        status: "fresh",
        asOf: "2026-08-05",
        updatedAt: "2026-08-05T00:00:00.000Z",
        ageDays: 0
      }
    }
  };
}

async function expectRuntimeError(task, code) {
  await assert.rejects(task, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.statusCode, 409);
    return true;
  });
}

(async () => {
  const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "region-workflow-revision-"));
  const filePath = path.join(fixtureRoot, "region_insights", "regions.json");
  let tick = 0;
  const runtime = createRegionInsightRuntime({
    filePath,
    registry,
    clock: () => new Date(Date.UTC(2026, 7, 5, 0, tick++)),
    idFactory: ({ regionKey, version }) => `publication:${regionKey}:${version}`
  });

  try {
    const created = await runtime.saveDraft(
      "kr_gyeonggi_pocheon",
      draftPayload(),
      { id: "admin-one", displayName: "Admin One" }
    );
    assert.equal(created.regionInsight.workflowRevision, 1);
    const draftHash = created.regionInsight.state.draftHash;

    await expectRuntimeError(
      () => runtime.saveDraft("kr_gyeonggi_pocheon", {
        ...draftPayload(74),
        expectedDraftHash: draftHash
      }, { id: "admin-two" }),
      "REGION_WORKFLOW_REVISION_REQUIRED"
    );
    await expectRuntimeError(
      () => runtime.saveDraft("kr_gyeonggi_pocheon", {
        ...draftPayload(74),
        expectedDraftHash: draftHash,
        expectedWorkflowRevision: 0
      }, { id: "admin-two" }),
      "REGION_WORKFLOW_REVISION_CONFLICT"
    );

    const reviewed = await runtime.reviewDraft("kr_gyeonggi_pocheon", {
      status: "reviewed",
      expectedDraftHash: draftHash,
      expectedWorkflowRevision: 1,
      adminMemo: "first reviewer wins"
    }, { id: "admin-one", displayName: "Admin One" });
    assert.equal(reviewed.regionInsight.workflowRevision, 2);

    await expectRuntimeError(
      () => runtime.reviewDraft("kr_gyeonggi_pocheon", {
        status: "changes_requested",
        expectedDraftHash: draftHash,
        expectedWorkflowRevision: 1,
        adminMemo: "stale competing review"
      }, { id: "admin-two" }),
      "REGION_WORKFLOW_REVISION_CONFLICT"
    );
    const afterReviewConflict = await runtime.readAdminRegion("kr_gyeonggi_pocheon");
    assert.equal(afterReviewConflict.regionInsight.workflowRevision, 2);
    assert.equal(afterReviewConflict.regionInsight.state.review.status, "reviewed");
    assert.equal(afterReviewConflict.regionInsight.state.review.adminMemo, "first reviewer wins");

    const published = await runtime.publishDraft("kr_gyeonggi_pocheon", {
      expectedDraftHash: draftHash,
      expectedWorkflowRevision: 2,
      version: "2026.08.05.1"
    }, { id: "admin-one" });
    assert.equal(published.regionInsight.workflowRevision, 3);
    assert.equal(published.regionInsight.state.publication.status, "published");

    await expectRuntimeError(
      () => runtime.publishDraft("kr_gyeonggi_pocheon", {
        expectedDraftHash: draftHash,
        expectedWorkflowRevision: 2,
        version: "2026.08.05.2"
      }, { id: "admin-two" }),
      "REGION_WORKFLOW_REVISION_CONFLICT"
    );

    const changed = await runtime.saveDraft("kr_gyeonggi_pocheon", {
      ...draftPayload(41),
      expectedDraftHash: draftHash,
      expectedWorkflowRevision: 3
    }, { id: "admin-two" });
    assert.equal(changed.regionInsight.workflowRevision, 4);
    assert.equal(changed.regionInsight.state.publication.status, "stale");
    assert.equal(changed.regionInsight.publicationHistory[0].publication.status, "stale");
    assert.equal(
      changed.regionInsight.publicationHistory[0].publication.staleAt,
      changed.regionInsight.state.publication.staleAt
    );

    const unchangedSave = await runtime.saveDraft("kr_gyeonggi_pocheon", {
      ...draftPayload(41),
      expectedDraftHash: changed.regionInsight.state.draftHash,
      expectedWorkflowRevision: 4
    }, { id: "admin-two" });
    assert.equal(unchangedSave.regionInsight.workflowRevision, 5, "every successful mutation advances the workflow revision");

    await expectRuntimeError(
      () => runtime.saveDraft("kr_gangwon_sokcho", {
        ...draftPayload(),
        expectedWorkflowRevision: 7
      }, { id: "admin-one" }),
      "REGION_WORKFLOW_REVISION_CONFLICT"
    );
    const untouched = await runtime.readAdminRegion("kr_gangwon_sokcho");
    assert.equal(untouched.regionInsight, null);
  } finally {
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
    assert.equal(networkGuard.blockedAttempts(), 0);
    networkGuard.restore();
  }

  console.log("Region insight workflow revision fixture checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
