"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  childEnvironment,
  jobApprovalDigest,
  normalizeJob,
  parseCsv,
  runFailureFixture,
  runPair,
  verifyBaseline,
  workbookDependencyStatus
} = require("./v2_place_artifact_harness.cjs");

const ROOT = path.resolve(__dirname, "..");
const guard = installFixtureNetworkGuard({ label: "V2 Place artifact harness fixtures" });
const roots = [];
let assertionCount = 0;

function check(actual, expected, message) {
  assertionCount += 1;
  assert.deepEqual(actual, expected, message);
}

function baseJob(runId, fixtureScenario = "success") {
  return normalizeJob({
    schemaVersion: "v2-place-artifact-job.v1",
    runId,
    mode: "offline",
    keyword: "경남 글램핑",
    checkIn: "2026-08-13",
    checkOut: "2026-08-13",
    timeoutMs: 25_000,
    responseSizeLimitBytes: 2 * 1024 * 1024,
    fixtureScenario
  });
}

async function temporaryRoot(label) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `v2-place-${label}-`));
  roots.push(root);
  return root;
}

async function readPair(root, runId) {
  return JSON.parse(await fsp.readFile(path.join(root, runId, "pair-result.json"), "utf8"));
}

function expectHarnessCode(promise, code) {
  return assert.rejects(promise, (error) => {
    assertionCount += 1;
    return error?.code === code;
  });
}

function runBoundaryChild({ job, targetRoot, source }) {
  fs.mkdirSync(targetRoot, { recursive: false });
  const environment = childEnvironment({
    job,
    targetRoot,
    transportMode: "offline",
    replayFile: "",
    workbookMode: "projection",
    workbookFailAt: 0
  });
  return spawnSync(process.execPath, ["-e", source], {
    cwd: ROOT,
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true
  });
}

async function scanFiles(root) {
  const values = [];
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) values.push({ file: absolute, content: await fsp.readFile(absolute) });
    }
  }
  await visit(root);
  return values;
}

(async () => {
  try {
    process.env.NODE_ENV = "test";
    const baseline = await verifyBaseline();
    check(baseline.sourceFileCount, 20, "all baseline source files must match the manifest");
    check(baseline.phase1LiveEvidencePresent, true, "Phase 1 live evidence must be available and hash-verified on this machine");
    const dependency = workbookDependencyStatus();
    check(dependency.installed, true, "approved write-excel-file dependency must be installed");
    check(dependency.version, "4.1.1", "installed workbook dependency must match the lockfile version");

    const liveJob = normalizeJob({
      ...baseJob("fixture-live-gate-0001"),
      mode: "live",
      fixtureScenario: "none"
    });
    const liveGateRoot = await temporaryRoot("live-gate");
    await expectHarnessCode(
      runPair(liveJob, { evidenceRoot: liveGateRoot, allowTestRoot: true }),
      "V2_PLACE_ARTIFACT_LIVE_APPROVAL_REQUIRED"
    );
    check(jobApprovalDigest(liveJob).length, 64, "live job must have a stable approval digest without executing it");

    for (const invalid of [
      { ...baseJob("invalid-job-0001"), unexpected: true },
      { ...baseJob("invalid-job-0002"), keyword: "bad\nkeyword" },
      { ...baseJob("invalid-job-0003"), checkOut: "2026-08-14" },
      { ...baseJob("invalid-job-0004"), responseSizeLimitBytes: 1 },
      { ...baseJob("invalid-job-0005"), fixtureScenario: "invented-provider-data" }
    ]) {
      assert.throws(() => normalizeJob(invalid), (error) => {
        assertionCount += 1;
        return error?.code === "V2_PLACE_ARTIFACT_JOB_INVALID";
      });
    }

    const successRoot = await temporaryRoot("success");
    const successJob = baseJob("fixture-success-0001", "success");
    const success = await runPair(successJob, { evidenceRoot: successRoot, allowTestRoot: true });
    check(success.comparison.replayExactArtifactParity, true, "same-response copied replay must be exact");
    check(success.comparison.independentExactArtifactParity, true, "offline original/copy must be exact");
    check(success.original.naturalPlaceIds, ["1001", "1002", "1003", "1004"], "natural order must be preserved");
    check(success.original.advertisementPlaceIds, ["1002", "2001", "2002"], "advertisement order must be preserved");
    check(success.original.naturalRanks, [1, 2, 3, 4], "natural ranks must be one-based array order");
    check(success.original.advertisementOrders, [1, 2, 3], "advertisement order must be one-based array order");
    check(success.original.missingManifestFiles.length, 0, "all native files including XLSX must be present");
    check(success.original.nativeArtifactComplete, true, "native artifact set must be complete");
    check(success.classification.nativePlaceOnlyJson, false, "collector must not invent a native Place-only JSON artifact");
    check(success.externalRequestCount, 0, "offline suite must make no external request");
    check([success.bookingRequests, success.priceInventoryRequests, success.regionalRequests, success.otaRequests], [0, 0, 0, 0], "excluded operations must remain zero");

    const pair = await readPair(successRoot, successJob.runId);
    const originalDirectory = path.join(successRoot, successJob.runId, ...pair.original.evidenceDirectory.split("/"));
    const manifest = JSON.parse(await fsp.readFile(path.join(originalDirectory, "manifest.json"), "utf8"));
    const overallText = await fsp.readFile(path.join(originalDirectory, manifest.fileRoles.overall), "utf8");
    const overall = parseCsv(overallText);
    check(overall.headers, success.original.csvHeaders.overall, "CSV parser must preserve exact header order");
    check(overall.rows[0].업체명.startsWith("'=HYPERLINK"), true, "formula-looking CSV values must be neutralized");
    check(overall.rows[0].주소, "경남 합천군 Synthetic road, 1", "CSV comma escaping must round-trip");
    check(overall.rows[0].특장점, "Line one\nLine two", "CSV quoted newline must round-trip");
    check(manifest.documentType, "lodging-collection-manifest", "native manifest document type must be preserved");
    check(manifest.schemaVersion, 2, "native manifest schema version must be preserved");
    check(Object.hasOwn(manifest, "digest"), false, "native manifest has no content digest and must not be described as having one");
    check(manifest.counts.naverOverall, 4, "manifest natural count must match stored rows");
    check(manifest.counts.naverAds, 3, "manifest advertisement count must match stored rows");
    check([manifest.mainPlaceRequestCount, manifest.providerRequestCount], [1, 1], "manifest must record exactly one main Place request");
    check(manifest.providerCallCounts, null, "legacy limited manifest leaves the newer structured call-count field null");
    check(manifest.automaticRetry, false, "automatic retry must remain disabled");
    check(manifest.automaticFallback, false, "automatic fallback must remain disabled");
    check(manifest.collectionProfileFlags, {
      collectRegional: false,
      collectOta: false,
      collectBookingStock: false,
      collectWeeklyRange: false
    }, "fast main-place profile must keep excluded operations disabled");

    const workbookAudit = JSON.parse(await fsp.readFile(path.join(successRoot, successJob.runId, "original", "audit", "workbook.json"), "utf8"));
    check(workbookAudit.callCount, 2, "native collector must invoke both workbook writers");
    check(workbookAudit.dependency.binaryGenerated, true, "approved dependency must generate native XLSX binaries");
    check(workbookAudit.calls[0].sheets.map((sheet) => sheet.name), ["요약", "플랫폼테스트", "네이버전체순위", "네이버광고순위", "네이버지역별상위5", "떠나요"], "full workbook sheets must preserve order");
    check(workbookAudit.calls[1].sheets.map((sheet) => sheet.name), ["요약", "지역별상위5", "전체순위", "광고순위"], "Naver workbook sheets must preserve order");
    const overallSheet = workbookAudit.calls[1].sheets.find((sheet) => sheet.name === "전체순위");
    check(overallSheet.columns, success.original.csvHeaders.overall, "XLSX projection columns must match native CSV columns");
    check(overallSheet.columnCellKinds.overall_rank, ["number"], "XLSX rank cells must remain numeric");
    check(overallSheet.columnCellKinds.place_id, ["string"], "XLSX Place IDs must remain strings");
    check(success.original.nativeWorkbooks.length, 2, "both native XLSX files must be inspected");
    check(success.original.nativeWorkbooks.every((workbook) => workbook.archiveEntryCount > 0), true, "native XLSX files must be readable OOXML archives");
    check(
      success.original.nativeWorkbooks.map((workbook) => workbook.semanticDigest),
      success.replay.nativeWorkbooks.map((workbook) => workbook.semanticDigest),
      "same-response replay XLSX semantics must match the original"
    );
    check(
      success.original.nativeWorkbooks.map((workbook) => workbook.semanticDigest),
      success.copied.nativeWorkbooks.map((workbook) => workbook.semanticDigest),
      "independent offline copy XLSX semantics must match after dynamic-time canonicalization"
    );

    await expectHarnessCode(
      runPair(successJob, { evidenceRoot: successRoot, allowTestRoot: true }),
      "V2_PLACE_ARTIFACT_RUN_ALREADY_EXISTS"
    );

    const noAdsRoot = await temporaryRoot("no-ads");
    const noAds = await runPair(baseJob("fixture-no-ads-0001", "no_ads"), { evidenceRoot: noAdsRoot, allowTestRoot: true });
    check(noAds.original.naturalRowCount, 2, "no-ad scenario must preserve natural rows");
    check(noAds.original.advertisementRowCount, 0, "missing ad contract must produce no ad rows");

    const emptyRoot = await temporaryRoot("empty");
    const empty = await runPair(baseJob("fixture-empty-0001", "empty"), { evidenceRoot: emptyRoot, allowTestRoot: true });
    check([empty.original.naturalRowCount, empty.original.advertisementRowCount], [0, 0], "empty response must publish header-only ranking artifacts");

    const duplicateRoot = await temporaryRoot("duplicates");
    const duplicate = await runPair(baseJob("fixture-duplicates-0001", "duplicates"), { evidenceRoot: duplicateRoot, allowTestRoot: true });
    check(duplicate.original.naturalPlaceIds, ["3101", "3101", "3102"], "natural duplicate IDs must be preserved by the V2 writer");
    check(duplicate.original.advertisementPlaceIds, ["3101", "4101", "4101"], "cross-list and ad duplicate IDs must be preserved");

    const missingRoot = await temporaryRoot("missing");
    const missingJob = baseJob("fixture-missing-0001", "missing_fields");
    const missing = await runPair(missingJob, { evidenceRoot: missingRoot, allowTestRoot: true });
    const missingPair = await readPair(missingRoot, missingJob.runId);
    const missingDirectory = path.join(missingRoot, missingJob.runId, ...missingPair.original.evidenceDirectory.split("/"));
    const missingManifest = JSON.parse(await fsp.readFile(path.join(missingDirectory, "manifest.json"), "utf8"));
    const missingCsv = parseCsv(await fsp.readFile(path.join(missingDirectory, missingManifest.fileRoles.overall), "utf8"));
    check(missing.original.naturalRowCount, 2, "rows with missing optional fields must remain rows");
    check([missingCsv.rows[0].업체명, missingCsv.rows[0].카테고리, missingCsv.rows[0].주소, missingCsv.rows[0].예약], ["", "", "", ""], "missing fields must map to empty CSV cells");

    const limitRoot = await temporaryRoot("limit");
    const limit = await runPair(baseJob("fixture-limit-0001", "limit"), { evidenceRoot: limitRoot, allowTestRoot: true });
    check(limit.original.naturalRowCount, 50, "natural results must be capped at 50");
    check(limit.original.advertisementRowCount, 55, "V2 does not cap the ad array and the harness must not invent a cap");
    check([limit.original.providerTotal, limit.original.providerAdTotal], [999, 777], "Provider totals must remain distinct from stored row counts");

    const failureRoot = await temporaryRoot("partial");
    const failure = await runFailureFixture({
      inputJob: baseJob("fixture-partial-0001", "partial_artifact_failure"),
      evidenceRoot: failureRoot,
      allowTestRoot: true,
      workbookFailAt: 1
    });
    check(failure.finalDirectoryCount, 0, "partial failure must not publish a final directory");
    check(failure.pendingDirectoryCount, 0, "partial failure staging directory must be removed");

    const boundaryRoot = await temporaryRoot("boundary");
    const endpointTarget = path.join(boundaryRoot, "endpoint");
    const endpoint = runBoundaryChild({
      job: baseJob("boundary-endpoint-0001"),
      targetRoot: endpointTarget,
      source: "fetch('https://m.booking.naver.com/graphql',{method:'GET',redirect:'manual'}).catch(e=>{console.log(e.code);process.exitCode=19})"
    });
    check(endpoint.status, 19, "booking endpoint must fail closed");
    assert.match(endpoint.stdout, /V2_PLACE_ARTIFACT_REQUEST_FORBIDDEN/u);
    assertionCount += 1;

    const budgetTarget = path.join(boundaryRoot, "budget");
    const budget = runBoundaryChild({
      job: baseJob("boundary-budget-0001"),
      targetRoot: budgetTarget,
      source: "const u='https://pcmap.place.naver.com/accommodation/list?query=fixture';(async()=>{await fetch(u,{method:'GET',redirect:'manual'});await fetch(u,{method:'GET',redirect:'manual'})})().catch(e=>{console.log(e.code);process.exitCode=23})"
    });
    check(budget.status, 23, "a second Place request must exceed the budget");
    assert.match(budget.stdout, /V2_PLACE_ARTIFACT_CALL_BUDGET_EXCEEDED/u);
    assertionCount += 1;

    const escapeTarget = path.join(boundaryRoot, "escape");
    const outsideFile = path.join(boundaryRoot, "outside-write.txt");
    const escape = runBoundaryChild({
      job: baseJob("boundary-escape-0001"),
      targetRoot: escapeTarget,
      source: `try{require('node:fs').writeFileSync(${JSON.stringify(outsideFile)},'forbidden')}catch(e){console.log(e.code);process.exitCode=29}`
    });
    check(escape.status, 29, "writes outside the target root must fail closed");
    assert.match(escape.stdout, /V2_PLACE_ARTIFACT_OUTPUT_ESCAPE/u);
    assertionCount += 1;
    check(fs.existsSync(outsideFile), false, "outside file must not be created");

    const fakeSecrets = [
      `phase2-${"secret"}-sentinel-7c2e`,
      `${"Bearer"} phase2-forbidden`,
      `${"NID"}_${"AUT"}=phase2-forbidden`,
      `${"client"}_${"secret"}=phase2-forbidden`
    ];
    process.env.V2_PLACE_TEST_SECRET = fakeSecrets[0];
    const evidenceFiles = await scanFiles(successRoot);
    for (const { file, content } of evidenceFiles) {
      const text = content.toString("utf8");
      for (const secret of fakeSecrets) {
        check(text.includes(secret), false, `secret-like value leaked into ${path.basename(file)}`);
      }
      if (file.endsWith("sanitized-capture.json")) {
        check(text.includes("<!doctype html>"), false, "raw Provider HTML must not be stored");
        check(text.includes('"headers"'), false, "headers must not be stored in sanitized capture");
      }
    }

    check(guard.blockedAttempts(), 0, "parent test process must make no external request");
    console.log(JSON.stringify({
      schemaVersion: "v2-place-artifact-test-result.v1",
      status: "passed",
      assertions: assertionCount,
      scenarios: ["success", "no_ads", "empty", "duplicates", "missing_fields", "limit", "partial_artifact_failure"],
      externalRequests: 0,
      bookingRequests: 0,
      priceInventoryRequests: 0,
      regionalRequests: 0,
      otaRequests: 0,
      retries: 0,
      fallbacks: 0,
      operationalWrites: 0,
      rawProviderResponsesStored: false,
      workbookBinaryVerified: true
    }));
  } finally {
    delete process.env.V2_PLACE_TEST_SECRET;
    guard.restore();
    await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
  }
})().catch((error) => {
  guard.restore();
  console.error(error);
  process.exitCode = 1;
});
