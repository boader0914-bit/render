"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const { __test } = require("./glamping_app_server.cjs");
const {
  FROZEN_V2_COLLECTOR_BLOB,
  FROZEN_V2_COLLECTOR_STRATEGY,
  commitPromotedFrozenRun,
  isFrozenV2RunManifest,
  isVisibleCommittedFrozenRun,
  isTrustedFrozenPayload
} = require("./v2_frozen_collector_adapter.cjs");

const ROOT = path.resolve(__dirname, "..");
const PREVIEW_ROOT = "/var/data/v2-preview-runtime";

async function main() {
  const guard = installFixtureNetworkGuard({ label: "frozen V2 server integration fixture" });
  try {
    const request = {
      keyword: "Fixture Region Lodging",
      searchMode: "keyword",
      collectionMode: "precision",
      collectionPurpose: "revenue_detail",
      productMode: "all",
      checkIn: "2026-08-08",
      checkOut: "2026-08-08",
      detailRankRanges: "1-3",
      clientRequestId: "fixture-request",
      providerAttemptExplicit: true,
      runStamp: "20260807_110000"
    };
    const trusted = __test.trustedPreviewFrozenCrawlPayload(request, {
      previewRuntime: true,
      previewDataRoot: PREVIEW_ROOT,
      asOf: new Date("2026-08-07T02:00:00.000Z")
    });
    assert.equal(isTrustedFrozenPayload(trusted), true);
    assert.equal(trusted.collectorStrategy, FROZEN_V2_COLLECTOR_STRATEGY);

    assert.throws(
      () => __test.trustedPreviewFrozenCrawlPayload(request, {
        previewRuntime: true,
        previewDataRoot: "/var/data",
        asOf: new Date("2026-08-07T02:00:00.000Z")
      }),
      (error) => error?.code === "FROZEN_V2_PREVIEW_SCOPE_REQUIRED"
    );

    const plan = __test.frozenV2ExecutionPlan(trusted);
    assert.equal(plan.collectorStrategy, FROZEN_V2_COLLECTOR_STRATEGY);
    assert.equal(plan.collectorSourceBlob, FROZEN_V2_COLLECTOR_BLOB);
    assert.equal(plan.frozenV2Collector, true);
    assert.equal(plan.boundedInventoryActivation, false);
    assert.equal(plan.v2CollectorCompatibilityActivation, false);
    assert.equal(plan.detailRankRanges, "1-3");
    assert.equal(plan.detailPlaceLimit, 3);
    assert.equal(plan.bookingRangeDays, 1);
    assert.equal(plan.bookingRangePlaceLimit, 0);
    assert.equal(plan.selectedSearchCandidate, null, "current query planner must not rewrite the frozen query");

    const estimate = __test.estimateCrawlCompletion(trusted, { entries: [] });
    assert.equal(estimate.frozenV2Collector, true);
    assert.equal(estimate.basis.frozenV2.collectorStrategy, FROZEN_V2_COLLECTOR_STRATEGY);
    assert.equal(estimate.basis.frozenV2.workerBypassed, true);
    assert.equal(estimate.basis.boundedInventory, null);
    assert.equal(Object.hasOwn(estimate.basis, "workerTop20"), false);

    const sameContractLater = __test.trustedPreviewFrozenCrawlPayload(
      { ...request, runStamp: "19990101_000000" },
      { previewRuntime: true, previewDataRoot: PREVIEW_ROOT, asOf: new Date("2026-08-07T02:00:01.000Z") }
    );
    assert.equal(sameContractLater.runStamp, "20260807_110001", "HTTP-supplied run stamps must be ignored");
    assert.equal(
      __test.crawlPayloadSignature(trusted),
      __test.crawlPayloadSignature(sameContractLater),
      "same frozen contract must share one single-flight signature"
    );

    const serverSource = await fsp.readFile(path.join(ROOT, "scripts", "glamping_app_server.cjs"), "utf8");
    assert.match(serverSource, /async function runCrawlerInternal\(payload\)\s*\{\s*if \(isTrustedFrozenPayload\(payload\)\) return runFrozenV2CrawlerInternal\(payload\);/u);
    assert.match(serverSource, /const explicitLegacyFrozen = isExplicitLegacyFrozenCrawlRequest\(payload\)/u);
    assert.match(serverSource, /const trustedPayload = useTop20Worker[\s\S]{0,160}trustedPreviewFrozenCrawlPayload\(adminPayload\)/u);
    assert.match(serverSource, /&& isV2Top20WorkerEligible\(adminPayload\)/u);
    assert.equal(
      serverSource.includes("isV2Top20WorkerEligible(trustedPayload)"),
      false,
      "frozen payloads must not make Top20 Worker eligibility fail closed"
    );
    assert.match(serverSource, /const cached = frozenV2 \? null : reusableRecentCrawlResult\(signature\);/u);
    assert.match(serverSource, /if \(!failure && result\?\.runId && !isTrustedFrozenPayload\(job\.payload\)\)/u);
    assert.equal(typeof commitPromotedFrozenRun, "function");
    assert.equal(typeof isFrozenV2RunManifest, "function");
    assert.equal(typeof isVisibleCommittedFrozenRun, "function");
    assert.ok(
      (serverSource.match(/isVisibleCommittedFrozenRun\(dirPath, manifest\)/gu) || []).length >= 2,
      "listRuns and loadRun must hide uncommitted frozen runs"
    );
    assert.match(serverSource, /frozenCommitRead:\s*FROZEN_V2_UNCOMMITTED_READ/u);
    assert.match(serverSource, /afterAppend:\s*async \(historyResult\)[\s\S]{0,240}commitPromotedFrozenRun/u);
    assert.match(serverSource, /runId === FROZEN_V2_STAGING_DIRECTORY[\s\S]{0,420}isVisibleCommittedFrozenRun\(runDirectory, manifest\)/u);
    assert.match(
      serverSource,
      /const manifest = await readManifest\(runDirectory\);\s*visible = await isVisibleCommittedFrozenRun\(runDirectory, manifest\);/u,
      "history reads must validate the canonical run manifest even when parsing returned null"
    );
    assert.match(
      serverSource,
      /else if \(row\?\.collectorStrategy === FROZEN_V2_COLLECTOR_STRATEGY \|\| row\?\.frozenSourceBlob === FROZEN_V2_COLLECTOR_BLOB\) \{\s*visible = false;/u,
      "orphaned frozen history rows must fail closed after a rollback or crash"
    );
    assert.equal(guard.blockedAttempts(), 0);
    console.log("Frozen V2 server integration fixture passed");
  } finally {
    guard.restore();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
