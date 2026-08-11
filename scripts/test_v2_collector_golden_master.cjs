"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const { executeV2CollectorSingleSource, v2CollectorProviderPolicy } = require("./v2_collector_single_source.cjs");
const { buildV2Top20FinalArtifactFiles } = require("./collection_worker_v2_top20_artifact.cjs");

const ROOT = path.resolve(__dirname, "..");
const PRELOAD = path.join(__dirname, "naver_legacy_inventory_fixture_preload.cjs");
const NETWORK_GUARD_PRELOAD = path.join(__dirname, "fixture_network_guard_preload.cjs");
const guard = installFixtureNetworkGuard({ label: "V2 collector golden master" });

function contract(overrides = {}) {
  return {
    keyword: "Synthetic V2 lodging",
    searchMode: "keyword",
    collectionMode: "precision",
    collectionPurpose: "revenue_detail",
    productMode: "all",
    checkIn: "2026-08-23",
    checkOut: "2026-08-23",
    bookingRangeDays: 1,
    rankStart: 1,
    rankEnd: 50,
    detailRankStart: 1,
    detailRankEnd: 20,
    clientRequestId: "fixture-v2-golden-master-01",
    ...overrides
  };
}

function fixtureEnvironment(root, auditFile, mode) {
  return {
    ...process.env,
    NODE_ENV: "test",
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--require=${NETWORK_GUARD_PRELOAD.replace(/\\/gu, "/")}`,
      `--require=${PRELOAD.replace(/\\/gu, "/")}`
    ].filter(Boolean).join(" "),
    NAVER_INVENTORY_FIXTURE_ROOT: root,
    NAVER_INVENTORY_FIXTURE_MODE: mode,
    NAVER_INVENTORY_FIXTURE_AUDIT_FILE: auditFile,
    SEARCH_INTENT: "",
    SEARCH_INTENT_CONFIDENCE: "0"
  };
}

function artifactSummary(result) {
  const summary = result.files.find((file) => file.path === "top20-summary.json");
  assert.ok(summary, "actual V2 child must emit a top20 summary artifact");
  return JSON.parse(summary.content);
}

async function executeActualChild(input) {
  return executeV2CollectorSingleSource({
    contract: input.contract,
    contractHash: input.contractHash,
    executionIdentityHash: input.executionIdentityHash,
    tempBase: input.root,
    cwd: ROOT,
    baseEnvironment: fixtureEnvironment(input.root, input.auditFile, input.mode),
    heartbeat: async () => {},
    onProviderCall: input.onProviderCall || (async () => {}),
    mainPlaceProvider: input.mainPlaceProvider || { state: "closed" },
    bookingDetailProvider: input.bookingDetailProvider || { state: "closed" },
    historicalBookingHints: input.historicalBookingHints,
    bookingIdFallback: input.bookingIdFallback === true,
    maxRuntimeMs: 120_000
  });
}

(async () => {
  const roots = [];
  try {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-single-source-golden-"));
    roots.push(root);
    const auditFile = path.join(root, "calls.json");
    const providerCalls = [];
    const complete = await executeActualChild({
      contract: contract(), root, auditFile, mode: "success", contractHash: "a".repeat(64), executionIdentityHash: "b".repeat(64),
      onProviderCall: async (call) => { providerCalls.push(call); }
    });
    assert.equal(complete.executionProfile, "v2_collector_single_source.v2");
    assert.equal(complete.collectionStatus, "complete");
    assert.equal(complete.readyCount, 20);
    assert.equal(complete.providerCallCount, 81);
    assert.deepEqual(artifactSummary(complete).collectorExecution.collectorArchitecture, "v2_collector_single_source");
    assert.deepEqual(artifactSummary(complete).collectorExecution.naverSearchStrategy, "legacy_candidate");
    assert.deepEqual(artifactSummary(complete).collectorExecution.legacyFrozenUsed, false);
    assert.equal(providerCalls[0].operation, "main_place");
    assert.equal((await fs.readFile(auditFile, "utf8")).includes("http"), false);

    const oneDayFinalArtifact = buildV2Top20FinalArtifactFiles({
      files: complete.files,
      top20ContractHash: "c".repeat(64),
      contractHash: "a".repeat(64),
      executionIdentityHash: "b".repeat(64),
      providerWorkflowRevision: 1
    });
    assert.equal(oneDayFinalArtifact.summary.collectionStatus, "complete");
    assert.equal(oneDayFinalArtifact.summary.collectorExecution.collectorArchitecture, "v2_collector_single_source");
    assert.equal(oneDayFinalArtifact.summary.collectorExecution.naverSearchStrategy, "legacy_candidate");
    assert.equal(oneDayFinalArtifact.summary.collectorExecution.legacyFrozenUsed, false);

    const threeDayRoot = await fs.mkdtemp(path.join(os.tmpdir(), "v2-single-source-three-day-"));
    roots.push(threeDayRoot);
    const threeDay = await executeActualChild({
      contract: contract({ checkOut: "2026-08-25", bookingRangeDays: 3, clientRequestId: "fixture-v2-golden-master-3day" }),
      root: threeDayRoot,
      auditFile: path.join(threeDayRoot, "calls.json"),
      mode: "success",
      contractHash: "5".repeat(64),
      executionIdentityHash: "6".repeat(64)
    });
    const threeDayFinalArtifact = buildV2Top20FinalArtifactFiles({
      files: threeDay.files,
      top20ContractHash: "7".repeat(64),
      contractHash: "5".repeat(64),
      executionIdentityHash: "6".repeat(64),
      providerWorkflowRevision: 2
    });
    assert.equal(
      threeDayFinalArtifact.summary.collectionStatus,
      "complete",
      JSON.stringify({
        collectionStatus: threeDayFinalArtifact.summary.collectionStatus,
        executedCallCount: threeDayFinalArtifact.summary.executedCallCount,
        targetStatuses: artifactSummary(threeDay).targetResults.map((target) => target.detailCollectionStatus),
        targetFailureCodes: artifactSummary(threeDay).targetResults.map((target) => target.detailFailureCode || null)
      })
    );

    const partialRoot = await fs.mkdtemp(path.join(os.tmpdir(), "v2-single-source-partial-"));
    roots.push(partialRoot);
    const partialAudit = path.join(partialRoot, "calls.json");
    const partial = await executeActualChild({
      contract: contract({ clientRequestId: "fixture-v2-golden-master-02" }), root: partialRoot, auditFile: partialAudit,
      mode: "challenge_daily_schedule", contractHash: "c".repeat(64), executionIdentityHash: "d".repeat(64)
    });
    assert.equal(partial.collectionStatus, "rank_only");
    assert.equal(partial.providerCallCount, 4);
    assert.equal(partial.providerPolicy.detailLiveCallsAllowed, true);

    const placePageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "v2-single-source-place-page-"));
    roots.push(placePageRoot);
    const placePageCalls = [];
    const placePage = await executeActualChild({
      contract: contract({ clientRequestId: "fixture-v2-place-page-01" }), root: placePageRoot,
      auditFile: path.join(placePageRoot, "calls.json"), mode: "graphql_error_booking_business_first_place_page_success",
      contractHash: "e".repeat(64), executionIdentityHash: "f".repeat(64), bookingIdFallback: true,
      onProviderCall: async (call) => { placePageCalls.push(call.operation); }
    });
    const placePageSummary = artifactSummary(placePage);
    assert.equal(
      placePageSummary.targetResults[0].bookingBusinessIdSource,
      "place_page",
      `source=${placePageSummary.targetResults[0].bookingBusinessIdSource}; calls=${placePage.providerCallCount}; trace=${placePageCalls.join(",")}`
    );

    const historicalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "v2-single-source-historical-"));
    roots.push(historicalRoot);
    const historical = await executeActualChild({
      contract: contract({ clientRequestId: "fixture-v2-historical-01" }), root: historicalRoot,
      auditFile: path.join(historicalRoot, "calls.json"), mode: "graphql_error_booking_business_first_historical",
      contractHash: "1".repeat(64), executionIdentityHash: "2".repeat(64),
      bookingIdFallback: true,
      historicalBookingHints: [{
        placeId: "1001", bookingBusinessId: "2001", sourceRunId: "fixture-historical-run",
        verifiedAt: "2026-08-10T00:00:00.000Z", lastSeenAt: "2026-08-10T00:00:00.000Z"
      }]
    });
    assert.equal(artifactSummary(historical).targetResults[0].bookingBusinessIdSource, "historical_verified");

    const isolationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "v2-single-source-isolation-"));
    roots.push(isolationRoot);
    const isolated = await executeActualChild({
      contract: contract({ clientRequestId: "fixture-v2-isolation-01" }), root: isolationRoot,
      auditFile: path.join(isolationRoot, "calls.json"), mode: "partial_booking_items_second",
      contractHash: "3".repeat(64), executionIdentityHash: "4".repeat(64)
    });
    const isolatedSummary = artifactSummary(isolated);
    assert.equal(isolated.collectionStatus, "partial");
    assert.equal(isolatedSummary.targetResults[1].detailCollectionStatus, "failed");
    assert.equal(isolatedSummary.targetResults[2].detailCollectionStatus, "ready");

    const cooldown = v2CollectorProviderPolicy({
      mainPlace: { state: "closed" },
      bookingDetail: { state: "open", retryAt: "2099-01-01T00:00:00.000Z" },
      now: "2026-08-11T00:00:00.000Z"
    });
    assert.equal(cooldown.mainAllowed, true);
    assert.equal(cooldown.detailLiveCallsAllowed, false);
    assert.equal(cooldown.detailCooldown, true);
    assert.equal(guard.blockedAttempts(), 0);
    console.log("V2 collector golden master fixtures passed");
  } finally {
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
    guard.restore();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
