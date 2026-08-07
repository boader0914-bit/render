"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  FROZEN_V2_COLLECTOR_BLOB,
  FROZEN_V2_COLLECTOR_STRATEGY,
  FROZEN_V2_COMMIT_MARKER_FILE,
  FROZEN_V2_OVERALL_SUFFIX,
  buildTrustedFrozenPayload,
  buildFrozenContractSignature,
  buildFrozenExecutionIdentity,
  gitBlobHash,
  verifyFrozenCollectorIntegrity,
  prepareFrozenCollectorExecution,
  parseFrozenCollectorStdoutManifest,
  locateSingleFrozenRunDirectory,
  sanitizeFrozenRunArtifacts,
  validateStoredFrozenRunManifest,
  promoteValidatedFrozenRun,
  commitPromotedFrozenRun,
  readFrozenRunCommitState,
  isVisibleCommittedFrozenRun,
  safeCleanupFrozenStaging
} = require("./v2_frozen_collector_adapter.cjs");

const ROOT = path.resolve(__dirname, "..");

function buildFixturePayload(input, options = {}) {
  return buildTrustedFrozenPayload(input, { ...options, allowExplicitRunStamp: true });
}

function assertSystemTemp(candidate) {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(candidate));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `unsafe temp path: ${candidate}`);
}

async function writeSyntheticRun({ prepared, payload, naverOverall = 50 }) {
  const runId = `gyeongnam_glamping_${payload.runStamp}`;
  const runDirectory = path.join(prepared.stagingRoot, runId);
  await fsp.mkdir(runDirectory);
  const fileRoles = {
    platform: "fixture-platform.csv",
    report: "fixture-report.md",
    overall: `fixture-overall${FROZEN_V2_OVERALL_SUFFIX}`,
    ads: "fixture-ads.csv",
    regional: "fixture-regional.csv",
    ddnayo: "fixture-ddnayo.csv",
    workbook: "fixture-all.xlsx",
    naverWorkbook: "fixture-naver.xlsx"
  };
  const overallRows = ["overall_rank,place_id,예약,네이버예약재고수집상태,url"];
  for (let rank = 1; rank <= naverOverall; rank += 1) {
    overallRows.push([
      rank,
      `fixture-place-${rank}`,
      rank <= 3 ? "Y" : "N",
      rank <= 3 ? "성공" : "네이버예약 미노출",
      `https://provider.invalid/place/${rank}`
    ].join(","));
  }
  await fsp.writeFile(path.join(runDirectory, fileRoles.overall), `\uFEFF${overallRows.join("\n")}\n`, "utf8");
  await fsp.writeFile(
    path.join(runDirectory, fileRoles.platform),
    "channel,name,url\nnaver,+SUM(1),https://provider.invalid/place/1\n",
    "utf8"
  );
  await fsp.writeFile(path.join(runDirectory, fileRoles.ads), "ad_order,place_id\n1,fixture-ad-1\n2,fixture-ad-2\n", "utf8");
  await fsp.writeFile(
    path.join(runDirectory, fileRoles.regional),
    `regional_order,place_id\n${Array.from({ length: 10 }, (_, index) => `${index + 1},fixture-regional-${index + 1}`).join("\n")}\n`,
    "utf8"
  );
  await fsp.writeFile(path.join(runDirectory, fileRoles.ddnayo), "result_order,place_id\n", "utf8");
  await fsp.writeFile(
    path.join(runDirectory, fileRoles.report),
    "Synthetic frozen collector report with sufficient fixture detail. https://provider.invalid/report\n",
    "utf8"
  );
  const workbookFixture = Buffer.alloc(128);
  Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(workbookFixture);
  await fsp.writeFile(path.join(runDirectory, fileRoles.workbook), workbookFixture);
  await fsp.writeFile(path.join(runDirectory, fileRoles.naverWorkbook), workbookFixture);
  const manifest = {
    outputDir: runDirectory,
    keyword: payload.keyword,
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
    naverAttemptedQueries: ["https://provider.invalid/search?q=synthetic"],
    counts: {
      naverOverall,
      naverAds: 2,
      naverRegional: 10,
      naverBookingStockChecked: 3,
      naverBookingStockSucceeded: 3,
      ddnayo: 0
    }
  };
  await fsp.writeFile(path.join(runDirectory, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { runId, runDirectory, manifest };
}

async function main() {
  const guard = installFixtureNetworkGuard({ label: "frozen V2 adapter core fixture" });
  const runtimeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "frozen-v2-adapter-"));
  try {
    const outputsRoot = path.join(runtimeRoot, "outputs");
    await fsp.mkdir(outputsRoot);
    const priorRun = path.join(outputsRoot, "gyeongnam_glamping_20260801_010101");
    await fsp.mkdir(priorRun);
    await fsp.writeFile(path.join(priorRun, `prior${FROZEN_V2_OVERALL_SUFFIX}`), "place_id,네이버예약사업자ID\nfixture-1,booking-1\n", "utf8");
    await fsp.writeFile(path.join(priorRun, "ignore.csv"), "ignored", "utf8");

    const integrity = await verifyFrozenCollectorIntegrity({ rootDir: ROOT });
    assert.equal(integrity.actualBlob, FROZEN_V2_COLLECTOR_BLOB);
    assert.equal(gitBlobHash(await fsp.readFile(integrity.collectorPath)), FROZEN_V2_COLLECTOR_BLOB);

    const payload = buildFixturePayload({
      keyword: "합성 지역 글램핑",
      checkIn: "2026-08-07",
      checkOut: "2026-08-07",
      detailRankRanges: "1-3",
      bookingRangeDays: 1,
      bookingRangePlaceLimit: 3,
      sourceRole: "admin",
      collectionSource: "admin_search",
      runStamp: "20260807_101112",
      clientRequestId: " admin request / 15 ",
      providerAttemptExplicit: true
    });
    assert.equal(payload.collectorStrategy, FROZEN_V2_COLLECTOR_STRATEGY);
    assert.equal(Object.keys(payload).includes("keywordHash"), false);
    const identity = buildFrozenExecutionIdentity(payload);
    assert.match(identity.executionIdentityHash, /^[a-f0-9]{64}$/u);
    assert.equal(Object.hasOwn(identity, "keyword"), false, "safe identity must omit the keyword");
    assert.equal(payload.clientRequestId, "admin-request-15");
    assert.equal(payload.providerAttemptExplicit, true);
    await fsp.writeFile(path.join(priorRun, "manifest.json"), JSON.stringify({
      outputDir: priorRun,
      keyword: payload.keyword,
      searchMode: payload.searchMode,
      productMode: payload.productMode,
      collectionSource: payload.collectionSource
    }, null, 2), "utf8");
    const otherContractRun = path.join(outputsRoot, "other_glamping_20260802_010101");
    await fsp.mkdir(otherContractRun);
    await fsp.writeFile(
      path.join(otherContractRun, `other${FROZEN_V2_OVERALL_SUFFIX}`),
      "place_id,booking_id\nother-place,other-booking\n",
      "utf8"
    );
    await fsp.writeFile(path.join(otherContractRun, "manifest.json"), JSON.stringify({
      outputDir: otherContractRun,
      keyword: "Different Region Lodging",
      searchMode: payload.searchMode,
      productMode: payload.productMode,
      collectionSource: payload.collectionSource
    }, null, 2), "utf8");
    assert.equal(await isVisibleCommittedFrozenRun(priorRun, null), true, "a valid non-frozen legacy run remains visible");
    const corruptManifestRun = path.join(outputsRoot, "corrupt_glamping_20260803_010101");
    await fsp.mkdir(corruptManifestRun);
    await fsp.writeFile(path.join(corruptManifestRun, "manifest.json"), "{not-json", "utf8");
    assert.equal(
      await isVisibleCommittedFrozenRun(corruptManifestRun, null),
      false,
      "a missing or corrupt canonical manifest must fail closed even when the caller passes null"
    );
    const sameContractLater = buildFixturePayload({ ...payload, runStamp: "20260807_111213" });
    assert.equal(
      buildFrozenContractSignature(payload),
      buildFrozenContractSignature(sameContractLater),
      "single-flight contract signature must exclude the run stamp"
    );
    assert.notEqual(
      buildFrozenExecutionIdentity(payload).executionIdentityHash,
      buildFrozenExecutionIdentity(sameContractLater).executionIdentityHash,
      "execution identity must retain the run stamp"
    );

    const oldDefault = buildFixturePayload({
      keyword: "경남 글램핑",
      searchMode: "company",
      checkIn: "2026-08-07",
      checkOut: "2026-08-13",
      runStamp: "20260807_121314"
    });
    assert.equal(oldDefault.requestedSearchMode, "company");
    assert.equal(oldDefault.searchMode, "keyword", "regional glamping keyword must not be treated as a company");
    assert.equal(oldDefault.detailRankRanges, "1-10");
    assert.equal(oldDefault.bookingRangeDays, 7);
    assert.equal(oldDefault.bookingRangePlaceLimit, 10);
    const missingDateDefaults = buildFixturePayload(
      { keyword: "합성 기본 날짜", runStamp: "20260807_122314" },
      { asOf: new Date("2026-08-07T00:00:00.000Z") }
    );
    assert.equal(missingDateDefaults.checkIn, "2026-08-07");
    assert.equal(missingDateDefaults.checkOut, "2026-08-13");
    assert.equal(missingDateDefaults.bookingRangeDays, 7);
    const basic = buildFixturePayload({
      keyword: "합성 기본",
      collectionPurpose: "basic_db",
      checkIn: "2026-08-07",
      checkOut: "2026-08-13",
      runStamp: "20260807_131415"
    });
    assert.equal(basic.detailRankRanges, "1-50");
    assert.equal(basic.bookingRangePlaceLimit, 0);
    const demand = buildFixturePayload({
      keyword: "합성 수요",
      collectionPurpose: "demand_location",
      checkIn: "2026-08-07",
      checkOut: "2026-08-13",
      runStamp: "20260807_141516"
    });
    assert.equal(demand.detailRankRanges, "1-20");
    assert.equal(demand.bookingRangePlaceLimit, 0);
    const fast = buildFixturePayload({
      keyword: "합성 빠른 순위",
      collectionMode: "fast",
      checkIn: "2026-08-07",
      checkOut: "2026-08-13",
      runStamp: "20260807_151617"
    });
    assert.equal(fast.detailRankRanges, "없음");
    assert.equal(fast.bookingRangePlaceLimit, 0);

    await assert.rejects(
      () => prepareFrozenCollectorExecution({ payload: { ...payload }, rootDir: ROOT, outputsRoot, taskId: "untrusted" }),
      (error) => error?.code === "FROZEN_V2_PAYLOAD_UNTRUSTED"
    );

    const prepared = await prepareFrozenCollectorExecution({
      payload,
      rootDir: ROOT,
      outputsRoot,
      configDir: path.join(ROOT, "web", "data"),
      taskId: "fixture-success",
      baseEnv: {
        SystemRoot: "C:\\SyntheticWindows",
        WINDIR: "C:\\SyntheticWindows",
        PATH: "unsafe-executable-path",
        HOME: "unsafe-home",
        SESSION_SECRET: "synthetic-session-secret",
        NODE_EXTRA_CA_CERTS: "unsafe-ca-path",
        HTTPS_PROXY: "https://unsafe-proxy.invalid",
        NODE_PATH: "unsafe-global-module-path",
        NODE_OPTIONS: "--no-warnings",
        SEARCH_CANDIDATE_QUERY: "must-not-leak",
        NAVER_COLLECTOR_STRATEGY: "current"
      }
    });
    assert.equal(prepared.sourceBlob, FROZEN_V2_COLLECTOR_BLOB);
    assert.equal(prepared.args[1], payload.keyword);
    assert.equal(prepared.env.OUTPUTS_DIR, prepared.stagingRoot);
    assert.equal(prepared.env.DATA_DIR, prepared.stagingRoot);
    assert.equal(prepared.env.FROZEN_V2_WORKBOOK_ROOT, prepared.stagingRoot);
    assert.match(prepared.env.NODE_PATH, /frozen_v2_4e4e190[\\/]runtime/u);
    assert.equal(prepared.env.NODE_PATH.includes("unsafe-global-module-path"), false);
    assert.match(prepared.env.NODE_OPTIONS, /^--require=.*fetch_safety_preload\.cjs$/u);
    assert.equal(prepared.env.NODE_OPTIONS.includes("--no-warnings"), false);
    assert.equal(prepared.env.SEARCH_CANDIDATE_QUERY, undefined);
    assert.equal(prepared.env.NAVER_COLLECTOR_STRATEGY, undefined);
    assert.equal(prepared.env.PATH, undefined);
    assert.equal(prepared.env.HOME, undefined);
    assert.equal(prepared.env.SESSION_SECRET, undefined);
    assert.equal(prepared.env.NODE_EXTRA_CA_CERTS, undefined);
    assert.equal(prepared.env.HTTPS_PROXY, undefined);
    assert.equal(prepared.env.SystemRoot, "C:\\SyntheticWindows");
    assert.equal(prepared.env.WINDIR, "C:\\SyntheticWindows");
    assert.equal(prepared.env.NAVER_BOOKING_ID_FALLBACK, "1");
    assert.equal(prepared.fallbackInputs.seededRunCount, 0, "uncommitted legacy outputs must not seed the frozen child");
    assert.equal(
      await fsp.stat(path.join(prepared.stagingRoot, path.basename(otherContractRun))).then(() => true, () => false),
      false,
      "a different search contract must not seed historical booking identifiers"
    );
    assert.equal(
      await fsp.stat(path.join(prepared.stagingRoot, path.basename(priorRun))).then(() => true, () => false),
      false,
      "uncommitted legacy fallback data must not be copied"
    );

    const synthetic = await writeSyntheticRun({ prepared, payload });
    const printed = parseFrozenCollectorStdoutManifest(`progress only\n${JSON.stringify(synthetic.manifest, null, 2)}\n`);
    assert.equal(printed.outputDir, synthetic.runDirectory);
    const located = await locateSingleFrozenRunDirectory({
      stagingRoot: prepared.stagingRoot,
      runStamp: payload.runStamp,
      seededDirectoryNames: prepared.fallbackInputs.seededDirectoryNames
    });
    assert.equal(located.runId, synthetic.runId);
    const sanitized = await sanitizeFrozenRunArtifacts({
      stagingRoot: prepared.stagingRoot,
      runDirectory: synthetic.runDirectory
    });
    assert.ok(sanitized.sanitizedFileCount >= 6);
    const sanitizedPlatform = await fsp.readFile(path.join(synthetic.runDirectory, synthetic.manifest.fileRoles.platform), "utf8");
    assert.equal(
      sanitizedPlatform.includes("naver,'+SUM(1),[provider-url-removed]"),
      true,
      "CSV formulas must be neutralized"
    );
    const validation = await validateStoredFrozenRunManifest({
      payload,
      stagingRoot: prepared.stagingRoot,
      seededDirectoryNames: prepared.fallbackInputs.seededDirectoryNames,
      expectedNaverOverall: 50
    });
    const promoted = await promoteValidatedFrozenRun({ validation, outputsRoot });
    assert.equal(promoted.runId, synthetic.runId);
    assert.equal(promoted.collectorStrategy, FROZEN_V2_COLLECTOR_STRATEGY);
    assert.equal(await fsp.stat(promoted.runDirectory).then((stat) => stat.isDirectory()), true);
    assert.equal(
      await isVisibleCommittedFrozenRun(promoted.runDirectory, promoted.manifest),
      false,
      "a promoted frozen run must remain invisible before its history commit marker"
    );
    const committed = await commitPromotedFrozenRun({
      promoted,
      outputsRoot,
      history: { appended: 3, file: "history/observations.jsonl" },
      committedAt: "2026-08-07T02:30:00.000Z"
    });
    assert.equal(committed.committed, true);
    assert.equal(await isVisibleCommittedFrozenRun(promoted.runDirectory, promoted.manifest), true);
    const commitState = await readFrozenRunCommitState({
      runDirectory: promoted.runDirectory,
      manifest: promoted.manifest
    });
    assert.equal(commitState.reason, "committed");
    assert.equal(
      await fsp.stat(path.join(promoted.runDirectory, FROZEN_V2_COMMIT_MARKER_FILE)).then((stat) => stat.isFile()),
      true
    );
    assert.equal(await fsp.stat(prepared.stagingRoot).then(() => true, () => false), false);
    assert.equal(await fsp.stat(priorRun).then((stat) => stat.isDirectory()), true, "prior final run must be preserved");
    const stored = JSON.parse(await fsp.readFile(path.join(promoted.runDirectory, "manifest.json"), "utf8"));
    assert.equal(stored.outputDir, promoted.runDirectory);
    assert.equal(stored.collectorStrategy, FROZEN_V2_COLLECTOR_STRATEGY);
    assert.equal(stored.frozenCollector.sourceBlob, FROZEN_V2_COLLECTOR_BLOB);
    assert.equal(stored.frozenCollector.executionIdentityHash, identity.executionIdentityHash);
    assert.match(stored.frozenCollector.sourceManifestHash, /^[a-f0-9]{64}$/u);
    assert.match(stored.frozenCollector.resultTreeHash, /^[a-f0-9]{64}$/u);
    assert.equal(stored.providerUrlStorage, "redacted");
    const storedOverall = await fsp.readFile(path.join(promoted.runDirectory, synthetic.manifest.fileRoles.overall), "utf8");
    assert.equal(storedOverall.includes("https://"), false);
    assert.equal(storedOverall.includes("[provider-url-removed]"), true);

    const laterPayload = buildFixturePayload({ ...payload, runStamp: "20260807_111213" });
    const laterPrepared = await prepareFrozenCollectorExecution({
      payload: laterPayload,
      rootDir: ROOT,
      outputsRoot,
      configDir: path.join(ROOT, "web", "data"),
      taskId: "fixture-committed-fallback"
    });
    assert.equal(
      laterPrepared.fallbackInputs.seededRunCount,
      1,
      "only a hash-verified committed frozen run may seed fallback IDs"
    );
    assert.equal(laterPrepared.fallbackInputs.seededDirectoryNames[0], promoted.runId);
    assert.equal(
      await fsp.stat(path.join(laterPrepared.stagingRoot, promoted.runId, synthetic.manifest.fileRoles.overall)).then((stat) => stat.isFile()),
      true
    );
    await safeCleanupFrozenStaging({ outputsRoot, stagingRoot: laterPrepared.stagingRoot });

    await fsp.appendFile(path.join(promoted.runDirectory, synthetic.manifest.fileRoles.report), "tampered\n", "utf8");
    assert.equal(
      await isVisibleCommittedFrozenRun(promoted.runDirectory, promoted.manifest),
      false,
      "artifact tampering after commit must hide the frozen run"
    );

    await assert.rejects(
      () => safeCleanupFrozenStaging({ outputsRoot, stagingRoot: outputsRoot }),
      (error) => error?.code === "FROZEN_V2_PATH_BOUNDARY_FAILED" || error?.code === "FROZEN_V2_CLEANUP_REJECTED"
    );
    assert.equal(guard.blockedAttempts(), 0, "adapter fixture must not attempt external network access");
    console.log("Frozen V2 adapter core fixture passed");
  } finally {
    guard.restore();
    assertSystemTemp(runtimeRoot);
    await fsp.rm(runtimeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
