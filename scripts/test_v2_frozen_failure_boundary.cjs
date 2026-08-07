"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  FROZEN_V2_OVERALL_SUFFIX,
  buildTrustedFrozenPayload,
  createFrozenTaskStaging,
  sanitizeFrozenRunArtifacts,
  safeCleanupFrozenStaging,
  validateStoredFrozenRunManifest
} = require("./v2_frozen_collector_adapter.cjs");

function hashBuffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function writeFixtureRun({
  stagingRoot,
  payload,
  taskSuffix,
  keyword = payload.keyword,
  naverOverall = 50,
  bookingSucceeded = 3,
  report = "Synthetic frozen failure-boundary report with valid fixture content.\n"
}) {
  const runId = `fixture_glamping_${payload.runStamp}`;
  const runDirectory = path.join(stagingRoot, runId);
  await fsp.mkdir(runDirectory);
  const fileRoles = {
    platform: `platform-${taskSuffix}.csv`,
    report: `report-${taskSuffix}.md`,
    overall: `overall-${taskSuffix}${FROZEN_V2_OVERALL_SUFFIX}`,
    ads: `ads-${taskSuffix}.csv`,
    regional: `regional-${taskSuffix}.csv`,
    ddnayo: `ddnayo-${taskSuffix}.csv`,
    workbook: `all-${taskSuffix}.xlsx`,
    naverWorkbook: `naver-${taskSuffix}.xlsx`
  };
  const overallRows = ["overall_rank,place_id,예약,네이버예약재고수집상태"];
  for (let rank = 1; rank <= naverOverall; rank += 1) {
    overallRows.push(`${rank},fixture-place-${rank},${rank <= 3 ? "Y" : "N"},${rank <= 3 ? "성공" : "네이버예약 미노출"}`);
  }
  await fsp.writeFile(path.join(runDirectory, fileRoles.overall), `\uFEFF${overallRows.join("\n")}\n`, "utf8");
  await fsp.writeFile(path.join(runDirectory, fileRoles.platform), "channel,name\nnaver,Fixture lodging\n", "utf8");
  await fsp.writeFile(path.join(runDirectory, fileRoles.ads), "ad_order,place_id\n", "utf8");
  await fsp.writeFile(path.join(runDirectory, fileRoles.regional), "regional_order,place_id\n", "utf8");
  await fsp.writeFile(path.join(runDirectory, fileRoles.ddnayo), "result_order,place_id\n", "utf8");
  await fsp.writeFile(path.join(runDirectory, fileRoles.report), report, "utf8");
  const workbookFixture = Buffer.alloc(128);
  Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(workbookFixture);
  await fsp.writeFile(path.join(runDirectory, fileRoles.workbook), workbookFixture);
  await fsp.writeFile(path.join(runDirectory, fileRoles.naverWorkbook), workbookFixture);
  const manifest = {
    outputDir: runDirectory,
    keyword,
    searchMode: payload.searchMode,
    collectionMode: payload.collectionMode,
    collectionPurpose: payload.collectionPurpose,
    productMode: payload.productMode,
    checkIn: payload.checkIn,
    checkOut: payload.checkOut,
    adults: payload.adults,
    detailRankRanges: payload.detailRankRanges,
    bookingRangeDays: payload.bookingRangeDays,
    bookingRangePlaceLimit: payload.bookingRangePlaceLimit,
    sourceRole: payload.sourceRole,
    collectionSource: payload.collectionSource,
    fileRoles,
    files: Object.values(fileRoles),
    detailJsonFiles: [],
    counts: {
      naverOverall,
      naverAds: 0,
      naverRegional: 0,
      naverBookingStockChecked: 3,
      naverBookingStockSucceeded: bookingSucceeded,
      ddnayo: 0
    }
  };
  await fsp.writeFile(path.join(runDirectory, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await sanitizeFrozenRunArtifacts({ stagingRoot, runDirectory });
  return { runId, runDirectory, manifest, fileRoles };
}

async function main() {
  const guard = installFixtureNetworkGuard({ label: "frozen V2 failure boundary fixture" });
  const runtimeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "frozen-v2-failure-"));
  try {
    const outputsRoot = path.join(runtimeRoot, "outputs");
    await fsp.mkdir(outputsRoot);
    const priorRun = path.join(outputsRoot, "prior_glamping_20260801_010101");
    await fsp.mkdir(priorRun);
    const priorFile = path.join(priorRun, "prior.json");
    await fsp.writeFile(priorFile, "unchanged", "utf8");
    const priorHash = hashBuffer(await fsp.readFile(priorFile));

    const payload = buildTrustedFrozenPayload({
      keyword: "Fixture Region Lodging",
      searchMode: "keyword",
      collectionPurpose: "revenue_detail",
      productMode: "all",
      checkIn: "2026-08-08",
      checkOut: "2026-08-08",
      detailRankRanges: "1-3",
      runStamp: "20260807_120000"
    }, { allowExplicitRunStamp: true });

    const zeroStaging = await createFrozenTaskStaging({ outputsRoot, taskId: "zero-result" });
    const zeroRun = await writeFixtureRun({ stagingRoot: zeroStaging, payload, taskSuffix: "zero", naverOverall: 0 });
    await assert.rejects(
      () => validateStoredFrozenRunManifest({
        payload,
        stagingRoot: zeroStaging,
        runId: zeroRun.runId,
        runDirectory: zeroRun.runDirectory
      }),
      (error) => error?.code === "FROZEN_V2_PLACE_RESULT_INVALID"
    );
    assert.equal(await fsp.stat(path.join(outputsRoot, zeroRun.runId)).then(() => true, () => false), false);
    await safeCleanupFrozenStaging({ outputsRoot, stagingRoot: zeroStaging });

    const mismatchStaging = await createFrozenTaskStaging({ outputsRoot, taskId: "contract-mismatch" });
    const mismatchRun = await writeFixtureRun({
      stagingRoot: mismatchStaging,
      payload,
      taskSuffix: "mismatch",
      keyword: "Different Fixture Contract",
      naverOverall: 50
    });
    await assert.rejects(
      () => validateStoredFrozenRunManifest({
        payload,
        stagingRoot: mismatchStaging,
        runId: mismatchRun.runId,
        runDirectory: mismatchRun.runDirectory
      }),
      (error) => error?.code === "FROZEN_V2_RESULT_CONTRACT_MISMATCH"
    );
    assert.equal(await fsp.stat(path.join(outputsRoot, mismatchRun.runId)).then(() => true, () => false), false);
    await safeCleanupFrozenStaging({ outputsRoot, stagingRoot: mismatchStaging });

    const partialBookingStaging = await createFrozenTaskStaging({ outputsRoot, taskId: "partial-booking" });
    const partialBookingRun = await writeFixtureRun({
      stagingRoot: partialBookingStaging,
      payload,
      taskSuffix: "partial-booking",
      naverOverall: 3,
      bookingSucceeded: 2
    });
    await assert.rejects(
      () => validateStoredFrozenRunManifest({
        payload,
        stagingRoot: partialBookingStaging,
        runId: partialBookingRun.runId,
        runDirectory: partialBookingRun.runDirectory
      }),
      (error) => error?.code === "FROZEN_V2_DETAIL_RESULT_INCOMPLETE"
    );
    await safeCleanupFrozenStaging({ outputsRoot, stagingRoot: partialBookingStaging });

    const duplicateRankStaging = await createFrozenTaskStaging({ outputsRoot, taskId: "duplicate-rank" });
    const duplicateRankRun = await writeFixtureRun({
      stagingRoot: duplicateRankStaging,
      payload,
      taskSuffix: "duplicate-rank",
      naverOverall: 3
    });
    await fsp.writeFile(
      path.join(duplicateRankRun.runDirectory, duplicateRankRun.fileRoles.overall),
      "\uFEFFoverall_rank,place_id,예약,네이버예약재고수집상태\n1,fixture-place-1,Y,성공\n1,fixture-place-2,Y,성공\n3,fixture-place-3,Y,성공\n",
      "utf8"
    );
    await assert.rejects(
      () => validateStoredFrozenRunManifest({
        payload,
        stagingRoot: duplicateRankStaging,
        runId: duplicateRankRun.runId,
        runDirectory: duplicateRankRun.runDirectory
      }),
      (error) => error?.code === "FROZEN_V2_PLACE_RESULT_INVALID"
    );
    await safeCleanupFrozenStaging({ outputsRoot, stagingRoot: duplicateRankStaging });

    const rawHtmlStaging = await createFrozenTaskStaging({ outputsRoot, taskId: "raw-html" });
    await assert.rejects(
      () => writeFixtureRun({
        stagingRoot: rawHtmlStaging,
        payload,
        taskSuffix: "raw-html",
        naverOverall: 3,
        report: "Synthetic report contains prohibited provider markup <html><body>blocked</body></html>"
      }),
      (error) => error?.code === "FROZEN_V2_RESULT_TEXT_INVALID"
    );
    await safeCleanupFrozenStaging({ outputsRoot, stagingRoot: rawHtmlStaging });

    const partialCountStaging = await createFrozenTaskStaging({ outputsRoot, taskId: "valid-partial-count" });
    const partialCountRun = await writeFixtureRun({
      stagingRoot: partialCountStaging,
      payload,
      taskSuffix: "partial-count",
      naverOverall: 47
    });
    const validation = await validateStoredFrozenRunManifest({
      payload,
      stagingRoot: partialCountStaging,
      runId: partialCountRun.runId,
      runDirectory: partialCountRun.runDirectory
    });
    assert.equal(validation.naverOverall, 47, "the historical display=50 plan may return up to 50 results without fabricating missing ranks");
    await safeCleanupFrozenStaging({ outputsRoot, stagingRoot: partialCountStaging });

    assert.equal(hashBuffer(await fsp.readFile(priorFile)), priorHash, "failed staging must not alter a prior final run");
    const finalRuns = (await fsp.readdir(outputsRoot)).filter((name) => name.includes(`_${payload.runStamp}`));
    assert.deepEqual(finalRuns, [], "failed fixtures must not promote a final run");
    assert.equal(guard.blockedAttempts(), 0);
    console.log("Frozen V2 failure boundary fixture passed");
  } finally {
    guard.restore();
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(runtimeRoot));
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fsp.rm(runtimeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
