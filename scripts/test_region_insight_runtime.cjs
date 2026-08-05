"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const registry = require("../web/data/location_region_registry.json");
const { createLocationRegionMatcher } = require("./location_region_matcher.cjs");
const {
  createRegionInsightRuntime,
  projectB2BRegionInsight,
  resolveRunRegionContext
} = require("./region_insight_runtime.cjs");

global.fetch = async (url) => {
  throw new Error(`External requests are forbidden in region insight runtime fixtures: ${url}`);
};

const matcher = createLocationRegionMatcher(registry);
const matched = resolveRunRegionContext({
  run: { regionKey: "kr_gyeonggi_pocheon", keyword: "다른 검색어" }
}, { matcher });
assert.deepEqual(matched, {
  regionKey: "kr_gyeonggi_pocheon",
  matchStatus: "matched",
  sido: "경기",
  sigungu: "포천시",
  displayLabel: "경기 포천시"
});

const manifestMatched = resolveRunRegionContext({
  run: { searchRegionKey: "kr_gyeonggi_pocheon", keyword: "서울근교 감성숙소" }
}, { matcher });
assert.equal(manifestMatched.regionKey, "kr_gyeonggi_pocheon");
assert.equal(manifestMatched.matchStatus, "matched");

const legacyMatched = resolveRunRegionContext({
  run: { keyword: "포천 글램핑", provinceLabel: "경기도" }
}, { matcher });
assert.equal(legacyMatched.regionKey, "kr_gyeonggi_pocheon");
assert.equal(legacyMatched.matchStatus, "matched");

const ambiguous = resolveRunRegionContext({ run: { keyword: "고성 글램핑" } }, { matcher });
assert.equal(ambiguous.matchStatus, "ambiguous");
assert.equal(ambiguous.regionKey, "");
assert.equal(ambiguous.sido, "");
assert.equal(ambiguous.sigungu, "");

const explicitUnknown = resolveRunRegionContext({
  run: { regionKey: "kr_unknown_missing", keyword: "포천 글램핑", provinceLabel: "경기도" }
}, { matcher });
assert.equal(explicitUnknown.matchStatus, "unmatched");
assert.equal(explicitUnknown.regionKey, "");

function draftPayload(value = 73) {
  return {
    locationAttractiveness: {
      value,
      modelVersion: "location-attractiveness-fixture-v1",
      components: [
        { key: "market_demand", value, weight: 0.6, evidenceIds: ["evidence-demand-1"] },
        { key: "tourism_access", value: 70, weight: 0.4, evidenceIds: ["evidence-tourism-1"] }
      ]
    },
    dataQuality: {
      status: "partial",
      score: 78,
      grade: "B",
      penalties: [{ code: "sns_partial", message: "SNS 일부 미수집", points: 8 }],
      coverage: { numerator: 14, denominator: 18, note: "OTA 14/18곳" },
      freshness: { status: "fresh", asOf: "2026-08-05", updatedAt: "2026-08-05T00:00:00.000Z", ageDays: 0 }
    }
  };
}

async function expectRuntimeError(task, code, statusCode) {
  await assert.rejects(task, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    return true;
  });
}

(async () => {
  const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "region-insight-runtime-"));
  const filePath = path.join(fixtureRoot, "region_insights", "regions.json");
  let tick = 0;
  const runtime = createRegionInsightRuntime({
    filePath,
    registry,
    matcher,
    clock: () => new Date(Date.UTC(2026, 7, 5, 0, tick++)),
    idFactory: ({ regionKey, version }) => `publication:${regionKey}:${version}`
  });

  try {
    const before = await runtime.readAdminRegion("kr_gyeonggi_pocheon");
    assert.equal(before.action, "read");
    assert.equal(before.regionInsight, null);
    await assert.rejects(fsp.stat(filePath), { code: "ENOENT" });

    const drafted = await runtime.saveDraft(
      "kr_gyeonggi_pocheon",
      draftPayload(),
      { id: "admin-user", displayName: "관리자" }
    );
    assert.equal(drafted.action, "draft_saved");
    assert.equal(drafted.regionContext.regionKey, "kr_gyeonggi_pocheon");
    assert.equal(drafted.regionInsight.state.review.status, "draft");
    assert.equal(drafted.regionInsight.state.publication.status, "unpublished");
    assert.equal(drafted.regionInsight.workflowRevision, 1);
    assert.equal(projectB2BRegionInsight(drafted.regionInsight.state), null);
    const draftHash = drafted.regionInsight.state.draftHash;

    await expectRuntimeError(
      () => runtime.reviewDraft("kr_gyeonggi_pocheon", {
        status: "reviewed",
        expectedWorkflowRevision: 1
      }, { id: "admin-user" }),
      "REGION_DRAFT_HASH_REQUIRED",
      409
    );

    await expectRuntimeError(
      () => runtime.reviewDraft("kr_gyeonggi_pocheon", {
        status: "reviewed",
        expectedDraftHash: "f".repeat(64),
        expectedWorkflowRevision: 1
      }, { id: "admin-user" }),
      "REGION_DRAFT_CHANGED",
      409
    );

    const reviewed = await runtime.reviewDraft("kr_gyeonggi_pocheon", {
      status: "reviewed",
      expectedDraftHash: draftHash,
      expectedWorkflowRevision: 1,
      adminMemo: "review-secret"
    }, { id: "admin-user", displayName: "관리자" });
    assert.equal(reviewed.regionInsight.state.review.status, "reviewed");
    assert.equal(reviewed.regionInsight.state.review.reviewedDraftHash, draftHash);
    assert.equal(reviewed.regionInsight.state.review.reviewer.id, "admin-user");

    await expectRuntimeError(
      () => runtime.publishDraft("kr_gyeonggi_pocheon", {
        version: "missing-hash",
        expectedWorkflowRevision: 2
      }, { id: "admin-user" }),
      "REGION_DRAFT_HASH_REQUIRED",
      409
    );

    const published = await runtime.publishDraft("kr_gyeonggi_pocheon", {
      expectedDraftHash: draftHash,
      expectedWorkflowRevision: 2,
      version: "2026.08.05.1",
      publicationId: "client-controlled-publication-id",
      adminMemo: "publish-secret"
    }, { id: "admin-user", displayName: "관리자" });
    assert.equal(published.action, "published");
    assert.equal(published.regionInsight.state.publication.status, "published");
    assert.equal(published.regionInsight.publicationHistory.length, 1);
    assert.equal(published.regionInsight.publicationHistory[0].version, "2026.08.05.1");
    assert.equal(
      published.regionInsight.publicationHistory[0].publicationId,
      "publication:kr_gyeonggi_pocheon:2026.08.05.1",
      "publication IDs must be generated by the server"
    );

    await expectRuntimeError(
      () => runtime.publishDraft("kr_gyeonggi_pocheon", {
        expectedDraftHash: draftHash,
        expectedWorkflowRevision: 3,
        version: "2026.08.05.1"
      }, { id: "admin-user" }),
      "REGION_PUBLICATION_VERSION_CONFLICT",
      409
    );

    const publicPublished = projectB2BRegionInsight(published.regionInsight.state);
    assert.equal(publicPublished.regionKey, "kr_gyeonggi_pocheon");
    assert.equal(publicPublished.locationAttractiveness.value, 73);
    assert.equal(publicPublished.dataQuality.grade, "B");
    assert.equal(publicPublished.publication.status, "published");
    const publicText = JSON.stringify(publicPublished);
    for (const privateValue of [
      "draftHash",
      "reviewedDraftHash",
      "snapshotHash",
      "reviewer",
      "adminMemo",
      "auditHistory",
      "publicationHistory",
      "updatedBy",
      "review-secret",
      "publish-secret",
      "admin-user"
    ]) {
      assert.equal(publicText.includes(privateValue), false, `B2B projection leaked ${privateValue}`);
    }

    const changed = await runtime.saveDraft("kr_gyeonggi_pocheon", {
      ...draftPayload(41),
      expectedDraftHash: draftHash,
      expectedWorkflowRevision: 3
    }, { id: "admin-user" });
    assert.equal(changed.regionInsight.state.review.status, "review_required");
    assert.equal(changed.regionInsight.state.publication.status, "stale");
    assert.ok(changed.regionInsight.state.publication.staleAt, "draft changes must timestamp the stale transition");
    assert.equal(changed.regionInsight.publicationHistory.length, 1);
    assert.equal(changed.regionInsight.publicationHistory[0].publication.snapshot.locationAttractiveness.value, 73);
    const stalePublic = projectB2BRegionInsight(changed.regionInsight.state);
    assert.equal(stalePublic.publication.status, "stale");
    assert.equal(stalePublic.locationAttractiveness.value, 73, "B2B must keep reading the immutable published snapshot");
    assert.notEqual(changed.regionInsight.state.locationAttractiveness.value, stalePublic.locationAttractiveness.value);

    const changedHash = changed.regionInsight.state.draftHash;
    await runtime.reviewDraft("kr_gyeonggi_pocheon", {
      status: "reviewed",
      expectedDraftHash: changedHash,
      expectedWorkflowRevision: 4
    }, { id: "admin-user" });
    const republished = await runtime.publishDraft("kr_gyeonggi_pocheon", {
      expectedDraftHash: changedHash,
      expectedWorkflowRevision: 5,
      version: "2026.08.05.2"
    }, { id: "admin-user" });
    assert.equal(republished.regionInsight.publicationHistory.length, 2);
    assert.equal(republished.regionInsight.publicationHistory[0].publication.status, "superseded");
    assert.ok(republished.regionInsight.publicationHistory[0].publication.supersededAt);
    assert.equal(republished.regionInsight.publicationHistory[1].publication.status, "published");

    await runtime.reviewDraft("kr_gyeonggi_pocheon", {
      status: "changes_requested",
      expectedDraftHash: changedHash,
      expectedWorkflowRevision: 6
    }, { id: "admin-user" });
    const resubmitted = await runtime.saveDraft("kr_gyeonggi_pocheon", {
      ...draftPayload(55),
      expectedDraftHash: changedHash,
      expectedWorkflowRevision: 7
    }, { id: "admin-user" });
    assert.equal(resubmitted.regionInsight.state.review.status, "review_required");

    await expectRuntimeError(
      () => runtime.saveDraft("kr_unknown_missing", draftPayload(), { id: "admin-user" }),
      "CANONICAL_REGION_KEY_REQUIRED",
      400
    );

    const persisted = JSON.parse(await fsp.readFile(filePath, "utf8"));
    assert.equal(persisted.documentType, "region-insight-publication-store");
    assert.equal(persisted.schemaVersion, 1);
    assert.equal(persisted.regions.kr_gyeonggi_pocheon.publicationHistory.length, 2);

    const corruptHistoryPath = path.join(fixtureRoot, "corrupt-history", "regions.json");
    const corruptStore = structuredClone(persisted);
    corruptStore.regions.kr_gyeonggi_pocheon.publicationHistory.push(
      structuredClone(corruptStore.regions.kr_gyeonggi_pocheon.publicationHistory[0])
    );
    await fsp.mkdir(path.dirname(corruptHistoryPath), { recursive: true });
    await fsp.writeFile(corruptHistoryPath, `${JSON.stringify(corruptStore, null, 2)}\n`, "utf8");
    const strictHistoryRuntime = createRegionInsightRuntime({
      filePath: corruptHistoryPath,
      registry,
      matcher,
      idFactory: () => "fixture-publication-id"
    });
    await assert.rejects(
      () => strictHistoryRuntime.readStore(),
      /publicationId is duplicated|publication version is duplicated/,
      "duplicate immutable publication history entries must fail closed"
    );

    const serverTest = require("./glamping_app_server.cjs").__test;
    assert.deepEqual(serverTest.parseRegionInsightApiPath("/api/region-insights/kr_gyeonggi_pocheon"), {
      regionKey: "kr_gyeonggi_pocheon",
      action: "read"
    });
    assert.deepEqual(serverTest.parseRegionInsightApiPath("/api/region-insights/kr_gyeonggi_pocheon/publish"), {
      regionKey: "kr_gyeonggi_pocheon",
      action: "publish"
    });
    assert.equal(serverTest.parseRegionInsightApiPath("/api/region-insights/kr_gyeonggi_pocheon/private"), null);
    const serverSource = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
    const runtimeSource = fs.readFileSync(path.join(__dirname, "region_insight_runtime.cjs"), "utf8");
    assert.match(serverSource, /regionKey:\s*manifest\?\.searchRegionKey/);
    assert.match(serverSource, /\/api\/member\/runs\/[\s\S]*publicRunForRole\(data, USER_ROLES\.b2b\)/);
    assert.doesNotMatch(runtimeSource, /publicationHistory:[\s\S]{0,240}\.slice\(-100\)/);
    assert.doesNotMatch(runtimeSource, /payload\.publicationId/, "clients must not choose publication IDs");

    const b2bRun = serverTest.publicRunForRole({
      run: { id: "fixture-run", keyword: "포천 글램핑" },
      regionContext: matched,
      regionInsight: changed.regionInsight.state,
      adminRegionalOperations: { reviewer: "must-not-leak" },
      b2bRegionReviewSummary: { status: "public_ready", updatedAt: "must-not-leak" },
      privateServerField: "must-not-leak"
    }, "b2b");
    assert.deepEqual(b2bRun.regionContext, matched);
    assert.equal(b2bRun.regionInsight, undefined);
    assert.equal(b2bRun.b2bRegionInsight.locationAttractiveness.value, 73);
    assert.equal(b2bRun.adminRegionalOperations, undefined);
    assert.equal(b2bRun.b2bRegionReviewSummary, undefined);
    assert.equal(b2bRun.privateServerField, undefined);
    const b2bText = JSON.stringify(b2bRun);
    for (const privateValue of ["review-secret", "publish-secret", "admin-user", "draftHash", "adminMemo", "reviewer"]) {
      assert.equal(b2bText.includes(privateValue), false, `publicRunForRole leaked ${privateValue}`);
    }
    const unknownRoleRun = serverTest.publicRunForRole({
      run: { id: "unknown-role-run" },
      regionContext: matched,
      regionInsight: changed.regionInsight.state,
      privateServerField: "unknown-role-must-not-be-admin"
    }, "future-role");
    assert.equal(unknownRoleRun.privateServerField, undefined, "unknown roles must never receive the admin payload");

    const ambiguousRun = serverTest.publicRunForRole({
      run: { id: "ambiguous-run" },
      regionContext: { matchStatus: "ambiguous", regionKey: "kr_gyeonggi_pocheon", displayLabel: "고성 글램핑" },
      regionInsight: changed.regionInsight.state
    }, "b2b");
    assert.equal(ambiguousRun.regionContext.matchStatus, "ambiguous");
    assert.equal(ambiguousRun.regionContext.regionKey, "");
    assert.equal(ambiguousRun.b2bRegionInsight, null);

    const mismatchedInsightRun = serverTest.publicRunForRole({
      run: { id: "mismatched-insight-run" },
      regionContext: matched,
      regionInsight: {
        ...changed.regionInsight.state,
        regionKey: "kr_gangwon_sokcho"
      }
    }, "b2b");
    assert.equal(mismatchedInsightRun.regionContext.regionKey, "kr_gyeonggi_pocheon");
    assert.equal(mismatchedInsightRun.b2bRegionInsight, null);

    const invalidInsightRun = serverTest.publicRunForRole({
      run: { id: "invalid-insight-run" },
      regionContext: matched,
      regionInsight: { adminMemo: "malicious-secret", publication: { status: "published" } }
    }, "b2b");
    assert.equal(invalidInsightRun.b2bRegionInsight, null);
    assert.equal(JSON.stringify(invalidInsightRun).includes("malicious-secret"), false);
  } finally {
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  }

  console.log("Region insight runtime fixture checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
