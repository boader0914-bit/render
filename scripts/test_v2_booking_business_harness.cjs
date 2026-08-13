"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  GRAPHQL_DOCUMENTS
} = require("./naver_bounded_inventory_live_transport.cjs");
const {
  COPY_ONLY_APPROVED_JOB_SHA256: CHILD_COPY_ONLY_APPROVED_JOB_SHA256,
  COPY_ONLY_EXPECTED_ENVELOPE_SHA256,
  REQUEST_ENVELOPE_SCHEMA_VERSION,
  assertGraphqlBoundary,
  createOneShotFetchBoundary,
  fixtureEnvelope,
  requestEnvelope
} = require("./v2_booking_business_child.cjs");
const {
  ALLOWED_FIXTURE_SCENARIOS,
  BASELINE_COMMIT,
  BASELINE_PROTECTED_TREE_ENTRY_COUNT,
  BASELINE_PROTECTED_TREE_SHA256,
  COLLECTOR_BLOB,
  COPY_ONLY_APPROVED_JOB_SHA256,
  COPY_ONLY_JOB_SCHEMA_VERSION,
  D1_OUTPUT_ROOT,
  EXPECTED_BOOKING_BUSINESS_ID_HASH,
  LIVE_PLACE_ID_HASH,
  LOCKFILE_SHA256,
  SHALLOW_EXPECTED_HEAD_SOURCE_PATHS,
  SHALLOW_EXPECTED_PARENT_COMMIT,
  compareTargets,
  isolatedD1RunRoot,
  isolatedRunRoot,
  normalizeCopyOnlyJob,
  normalizeJob,
  readCopyOnlyJob,
  readJob,
  runCopyOnlyLive,
  runEnvelopeParity,
  runPair,
  runSingleFixture,
  sha256,
  stableJson,
  protectedTreeSnapshot,
  verifyBaseline,
  verifyCommitLineage,
  verifyPreviousLiveEvidence,
  verifyRuntime
} = require("./v2_booking_business_harness.cjs");

const ROOT = path.resolve(__dirname, "..");
const OFFLINE_JOB = path.join(ROOT, "tests", "fixtures", "v2_booking_business_job.json");
const LIVE_JOB = path.join(ROOT, "docs", "v2_booking_business_live_job.proposal.json");
const COPY_ONLY_JOB = path.join(ROOT, "docs", "v2_booking_business_copy_only_live_job.proposal.json");
const guard = installFixtureNetworkGuard({ label: "V2 booking-business harness fixtures" });
let assertions = 0;

function check(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

function throws(fn, expected, message) {
  assertions += 1;
  assert.throws(fn, expected, message);
}

async function rejects(fn, expected, message) {
  assertions += 1;
  await assert.rejects(fn, expected, message);
}

async function textFiles(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if ([".json", ".txt", ".md", ".csv"].includes(path.extname(entry.name))) output.push(absolute);
    }
  }
  await visit(root);
  return output;
}

function gitAt(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}

async function verifySyntheticShallowLineage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-booking-lineage-"));
  const source = path.join(root, "source");
  const shallow = path.join(root, "shallow");
  const mutated = path.join(root, "mutated");
  const allowedPaths = new Set(["allowed.txt"]);
  try {
    await fs.mkdir(source, { recursive: true });
    gitAt(source, ["init", "-b", "main"]);
    gitAt(source, ["config", "user.name", "Offline Fixture"]);
    gitAt(source, ["config", "user.email", "offline-fixture@example.invalid"]);
    await fs.writeFile(path.join(source, "protected.txt"), "protected\n", "utf8");
    await fs.writeFile(path.join(source, "allowed.txt"), "baseline\n", "utf8");
    gitAt(source, ["add", "."]);
    gitAt(source, ["commit", "-m", "baseline"]);
    const baselineCommit = gitAt(source, ["rev-parse", "HEAD"]);
    const protectedTree = protectedTreeSnapshot(source, allowedPaths);

    await fs.writeFile(path.join(source, "allowed.txt"), "parent\n", "utf8");
    gitAt(source, ["add", "allowed.txt"]);
    gitAt(source, ["commit", "-m", "parent"]);
    const parentCommit = gitAt(source, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(source, "allowed.txt"), "head\n", "utf8");
    gitAt(source, ["add", "allowed.txt"]);
    gitAt(source, ["commit", "-m", "head"]);
    const headCommit = gitAt(source, ["rev-parse", "HEAD"]);

    execFileSync("git", ["-c", "protocol.file.allow=always", "clone", "--depth", "1", "--single-branch", "--branch", "main", pathToFileURL(source).href, shallow], {
      stdio: "ignore",
      windowsHide: true
    });
    check(gitAt(shallow, ["rev-parse", "--is-shallow-repository"]), "true", "fixture clone must be shallow");
    check(
      verifyCommitLineage({
        baselineCommit,
        expectedHead: headCommit,
        expectedParent: parentCommit,
        protectedTreeEntryCount: protectedTree.count,
        protectedTreeSha256: protectedTree.sha256,
        root: shallow,
        allowedPaths,
        expectedHeadSourcePaths: ["allowed.txt"]
      }).verification,
      "shallow-pinned-head-parent-protected-tree",
      "pinned shallow checkout must pass without baseline objects"
    );
    throws(() => verifyCommitLineage({
      baselineCommit,
      expectedHead: "0".repeat(40),
      expectedParent: parentCommit,
      protectedTreeEntryCount: protectedTree.count,
      protectedTreeSha256: protectedTree.sha256,
      root: shallow,
      allowedPaths,
      expectedHeadSourcePaths: ["allowed.txt"]
    }), { code: "V2_BOOKING_BUSINESS_BASELINE_MISMATCH" }, "wrong shallow HEAD must fail closed");
    throws(() => verifyCommitLineage({
      baselineCommit,
      expectedHead: headCommit,
      expectedParent: "0".repeat(40),
      protectedTreeEntryCount: protectedTree.count,
      protectedTreeSha256: protectedTree.sha256,
      root: shallow,
      allowedPaths,
      expectedHeadSourcePaths: ["allowed.txt"]
    }), { code: "V2_BOOKING_BUSINESS_BASELINE_MISMATCH" }, "wrong shallow parent must fail closed");

    await fs.writeFile(path.join(shallow, "allowed.txt"), "tampered source\n", "utf8");
    throws(() => verifyCommitLineage({
      baselineCommit,
      expectedHead: headCommit,
      expectedParent: parentCommit,
      protectedTreeEntryCount: protectedTree.count,
      protectedTreeSha256: protectedTree.sha256,
      root: shallow,
      allowedPaths,
      expectedHeadSourcePaths: ["allowed.txt"]
    }), { code: "V2_BOOKING_BUSINESS_BASELINE_MISMATCH" }, "approved source worktree mutation must fail closed");
    await fs.writeFile(path.join(shallow, "allowed.txt"), "head\n", "utf8");
    await fs.writeFile(path.join(shallow, "protected.txt"), "tampered protected worktree\n", "utf8");
    throws(() => verifyCommitLineage({
      baselineCommit,
      expectedHead: headCommit,
      expectedParent: parentCommit,
      protectedTreeEntryCount: protectedTree.count,
      protectedTreeSha256: protectedTree.sha256,
      root: shallow,
      allowedPaths,
      expectedHeadSourcePaths: ["allowed.txt"]
    }), { code: "V2_BOOKING_BUSINESS_BASELINE_MISMATCH" }, "protected worktree mutation must fail closed");

    await fs.writeFile(path.join(source, "protected.txt"), "mutated\n", "utf8");
    gitAt(source, ["add", "protected.txt"]);
    gitAt(source, ["commit", "-m", "mutated protected tree"]);
    const mutatedHead = gitAt(source, ["rev-parse", "HEAD"]);
    execFileSync("git", ["-c", "protocol.file.allow=always", "clone", "--depth", "1", "--single-branch", "--branch", "main", pathToFileURL(source).href, mutated], {
      stdio: "ignore",
      windowsHide: true
    });
    throws(() => verifyCommitLineage({
      baselineCommit,
      expectedHead: mutatedHead,
      expectedParent: headCommit,
      protectedTreeEntryCount: protectedTree.count,
      protectedTreeSha256: protectedTree.sha256,
      root: mutated,
      allowedPaths,
      expectedHeadSourcePaths: ["allowed.txt"]
    }), { code: "V2_BOOKING_BUSINESS_BASELINE_MISMATCH" }, "protected tree mutation must fail closed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function validFetchInit(placeId, body) {
  return {
    method: "POST",
    headers: {
      accept: "*/*",
      "accept-language": "ko-KR,ko;q=0.9",
      "content-type": "application/json",
      origin: "https://pcmap.place.naver.com",
      referer: `https://pcmap.place.naver.com/accommodation/${placeId}`,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
    },
    redirect: "manual",
    body: JSON.stringify(body)
  };
}

async function main() {
  const roots = [];
  const shallowCheckout = gitAt(ROOT, ["rev-parse", "--is-shallow-repository"]) === "true";
  const baseline = await verifyBaseline();
  check(baseline.baselineCommit, BASELINE_COMMIT, "baseline identity must remain the N2 commit");
  check(baseline.collectorBlob, COLLECTOR_BLOB, "collector blob must remain frozen");
  check(baseline.lockfileSha256, LOCKFILE_SHA256, "lockfile must remain frozen");
  check(baseline.sourceFileCount, 20, "source dependency closure must contain 20 files");
  check(
    baseline.lineageVerification,
    shallowCheckout ? "shallow-pinned-head-parent-protected-tree" : "full-history",
    "lineage verification must match the available Git history"
  );
  check(BASELINE_PROTECTED_TREE_ENTRY_COUNT, 322, "protected baseline tree entry count must remain frozen");
  check(BASELINE_PROTECTED_TREE_SHA256, "33c33aa6298a69eeb6223731c001a0221d6f392b9d87fd74f240585a01ab89c4", "protected baseline tree digest must remain frozen");
  check(SHALLOW_EXPECTED_PARENT_COMMIT, "31f007b12e485b3a1ff280c57b33b5e9889c8ba6", "shallow deploy must pin its reviewed parent commit");
  check(SHALLOW_EXPECTED_HEAD_SOURCE_PATHS, [
    "docs/datalab_rebuild_phase3_d5_child_framing_diagnostics_report.md",
    "scripts/test_v2_booking_business_harness.cjs",
    "scripts/test_v2_booking_business_render_one_shot.cjs",
    "scripts/v2_booking_business_env_diagnostics.cjs",
    "scripts/v2_booking_business_harness.cjs",
    "scripts/v2_booking_business_render_one_shot.cjs"
  ], "shallow deploy source attestation must cover every new fix file");
  if (shallowCheckout) {
    check(
      baseline.expectedHeadSourceBlobs.length,
      SHALLOW_EXPECTED_HEAD_SOURCE_PATHS.length,
      "shallow verification must attest every fix source"
    );
  } else {
    check(
      verifyCommitLineage({
        baselineCommit: BASELINE_COMMIT,
        expectedHead: "0".repeat(40),
        expectedParent: "0".repeat(40),
        protectedTreeEntryCount: 0,
        protectedTreeSha256: "0".repeat(64)
      }).verification,
      "full-history",
      "full history must not depend on shallow fallback inputs"
    );
  }
  await verifySyntheticShallowLineage();

  const offlineRead = await readJob(OFFLINE_JOB);
  const liveRead = await readJob(LIVE_JOB);
  const copyOnlyRead = await readCopyOnlyJob(COPY_ONLY_JOB);
  check(offlineRead.job.mode, "offline", "offline job must validate");
  check(liveRead.job.mode, "live", "live proposal must validate");
  check(copyOnlyRead.job.schemaVersion, COPY_ONLY_JOB_SCHEMA_VERSION, "copy-only job schema must validate");
  check(copyOnlyRead.digest, COPY_ONLY_APPROVED_JOB_SHA256, "copy-only job digest must be frozen in code");
  check(copyOnlyRead.digest, CHILD_COPY_ONLY_APPROVED_JOB_SHA256, "parent and child copy-only job gates must match");
  check(copyOnlyRead.job.expectedEnvelopeSha256, COPY_ONLY_EXPECTED_ENVELOPE_SHA256, "copy-only envelope digest must be frozen");
  check(copyOnlyRead.job.expectedBookingBusinessIdHash, EXPECTED_BOOKING_BUSINESS_ID_HASH, "copy-only expected identity must match prior success evidence");
  check(sha256(liveRead.job.placeId), LIVE_PLACE_ID_HASH, "live target must be the approved Phase 2 rank-one Place");
  check(liveRead.job.source.rank, 1, "live target rank must be fixed");
  check(liveRead.job.source.phase2PairSha256, baseline.phase2LivePairSha256, "live target must be tied to Phase 2 evidence");

  const baseJob = offlineRead.job;
  for (const mutation of [
    { placeId: "not-numeric" },
    { timeoutMs: 0 },
    { responseSizeLimitBytes: 2 * 1024 * 1024 + 1 },
    { fixtureScenario: "booking_items" },
    { source: { ...baseJob.source, rank: 1 } }
  ]) {
    throws(() => normalizeJob({ ...baseJob, ...mutation }), { code: "V2_BOOKING_BUSINESS_JOB_INVALID" });
  }
  throws(() => isolatedRunRoot("../escape"), { code: "V2_BOOKING_BUSINESS_OUTPUT_PATH_INVALID" });
  throws(() => isolatedD1RunRoot("../escape"), { code: "V2_BOOKING_BUSINESS_OUTPUT_PATH_INVALID" });
  const runtime = verifyRuntime();
  check(runtime.nodeVersion, "v26.5.0", "D1 runtime must remain Node 26.5.0");
  check(runtime.undiciVersion, "8.7.0", "D1 runtime must remain bundled Undici 8.7.0");
  const previousEvidence = await verifyPreviousLiveEvidence();
  check(previousEvidence.originalAuditSha256, copyOnlyRead.job.previousOriginalAuditSha256, "previous original evidence must be immutable");
  check(previousEvidence.copiedAuditSha256, copyOnlyRead.job.previousCopiedAuditSha256, "previous copied evidence must be immutable");
  const copyOnlySource = runCopyOnlyLive.toString();
  check(copyOnlySource.includes("moduleRoot: copiedRoot"), true, "copy-only live must execute the hash-copied source root");
  check(copyOnlySource.includes("moduleRoot: ROOT"), false, "copy-only live must not contain an original-source execution path");
  check(copyOnlySource.includes("runPair("), false, "copy-only live must not call the historical pair runner");

  for (const mutation of [
    { runId: "another-run" },
    { mode: "live" },
    { notBefore: "not-a-date" },
    { expectedEnvelopeSha256: "0".repeat(64) },
    { expectedBookingBusinessIdHash: "0".repeat(64) },
    { previousCopiedAuditSha256: "0".repeat(64) }
  ]) {
    throws(
      () => normalizeCopyOnlyJob({ ...copyOnlyRead.job, ...mutation }),
      { code: "V2_BOOKING_BUSINESS_COPY_ONLY_JOB_INVALID" }
    );
  }

  const scenarioExpectations = {
    success: ["succeeded", "resolved", 200, null],
    zero_null_booking: ["succeeded", "zero", 200, null],
    zero_missing_booking: ["succeeded", "zero", 200, null],
    graphql_error: ["succeeded", "unavailable", 200, null],
    malformed_booking: ["succeeded", "unavailable", 200, null],
    business_null: ["failed", "failed", 200, "COLLECTION_FAILED"],
    malformed_json: ["succeeded", "unavailable", 200, null],
    http_403: ["failed", "failed", 403, "NAVER_ACCESS_BLOCKED"],
    http_429: ["failed", "failed", 429, "NAVER_ACCESS_BLOCKED"],
    http_405: ["succeeded", "unavailable", 405, null],
    http_405_challenge: ["failed", "failed", 405, "NAVER_ACCESS_BLOCKED"],
    challenge_html: ["failed", "failed", 200, "NAVER_ACCESS_BLOCKED"],
    http_500: ["succeeded", "unavailable", 500, null],
    timeout: ["succeeded", "unavailable", null, null],
    oversized: ["succeeded", "unavailable", 200, null]
  };

  for (const scenario of ALLOWED_FIXTURE_SCENARIOS) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `v2-booking-business-${scenario}-`));
    roots.push(root);
    const executionRoot = path.join(root, "execution");
    const target = await runSingleFixture(baseJob, scenario, executionRoot);
    const expected = scenarioExpectations[scenario];
    check(
      [target.projection.status, target.projection.classification, target.projection.providerStatus, target.projection.error?.code || null],
      expected,
      `${scenario} classification must match the original parser contract`
    );
    check(target.projection.calls.bookingBusiness, 1, `${scenario} must execute one business lookup`);
    check(target.projection.calls.bookingItems, 0, `${scenario} must not execute booking items`);
    check(target.projection.calls.dailySchedule, 0, `${scenario} must not execute schedules`);
    check(target.projection.calls.actualExternal, 0, `${scenario} must remain offline`);
    check(target.projection.calls.fixture, 1, `${scenario} must use exactly one fixture response`);
    check(target.projection.retries, 0, `${scenario} retries must remain zero`);
    check(target.projection.fallbacks, 0, `${scenario} fallbacks must remain zero`);
    check(target.projection.htmlFallbackCalls, 0, `${scenario} HTML fallback must remain zero`);
    check(target.projection.historicalFallbackReads, 0, `${scenario} historical fallback must remain zero`);
    check(target.projection.operationalWrites, 0, `${scenario} operational writes must remain zero`);
    check(target.projection.rawProviderResponseStored, false, `${scenario} raw response storage must remain disabled`);
    check(target.projection.headersStored, false, `${scenario} headers must not be stored`);
    check(target.projection.fullRequestUrlStored, false, `${scenario} full URL must not be stored`);
    check(target.projection.request.operationName, "naverBookingBusiness", `${scenario} operation must remain exact`);
    check(target.projection.request.variableNames, ["id", "isNx"], `${scenario} variables must remain exact`);
    check(target.projection.request.fetchEnvelope.schemaVersion, REQUEST_ENVELOPE_SCHEMA_VERSION, `${scenario} request envelope must be versioned`);
    check(target.projection.request.fetchEnvelope.envelopeSha256.length, 64, `${scenario} request envelope must have a digest`);
    check(target.projection.request.fetchEnvelope.headerValuesStored, false, `${scenario} header values must not be stored`);
    check(target.projection.request.fetchEnvelope.bodyStored, false, `${scenario} request body must not be stored`);
    check(target.projection.responseDiagnostic.rawBodyStored, false, `${scenario} response body must not be stored in diagnostics`);
    check(target.projection.responseDiagnostic.responseHeadersStored, false, `${scenario} response headers must not be stored in diagnostics`);
    const expectedContentTypeClass = ({
      http_403: "text",
      http_429: "text",
      http_405: "text",
      http_405_challenge: "html",
      challenge_html: "html",
      timeout: "none"
    })[scenario] || "json";
    check(target.projection.responseDiagnostic.contentTypeClass, expectedContentTypeClass, `${scenario} content-type class must be safe and exact`);
    check(
      target.projection.responseDiagnostic.fetchOutcome,
      scenario === "timeout" ? "fixture_timeout" : "fixture_response",
      `${scenario} fetch outcome must be safe and exact`
    );
    check(
      target.projection.responseDiagnostic.retryAfterSeconds,
      scenario === "http_429" ? 120 : null,
      `${scenario} response retry-after diagnostic must be bounded and exact`
    );
    const expectedSubtype = ({
      http_403: "http_403",
      http_429: "http_429",
      http_405_challenge: "challenge_html",
      challenge_html: "challenge_html"
    })[scenario] || null;
    check(target.projection.error?.providerFailureSubtype || null, expectedSubtype, `${scenario} safe failure subtype must be exact`);
    check(
      target.projection.error?.providerHttpStatus ?? null,
      expectedSubtype ? expected[2] : null,
      `${scenario} safe provider status metadata must be exact`
    );
    check(
      target.projection.error?.retryAfterSeconds ?? null,
      scenario === "http_429" ? 120 : null,
      `${scenario} retry-after diagnostic must be bounded and exact`
    );
  }

  const placeId = "1001";
  const query = GRAPHQL_DOCUMENTS.naver_booking_business;
  const validBody = {
    operationName: "naverBookingBusiness",
    query,
    variables: { id: placeId, isNx: false }
  };
  const validInit = validFetchInit(placeId, validBody);
  check(
    assertGraphqlBoundary("https://pcmap-api.place.naver.com/graphql", validInit, query, placeId),
    validBody,
    "exact GraphQL boundary must validate"
  );
  const envelope = requestEnvelope("https://pcmap-api.place.naver.com/graphql", validInit, validBody, placeId);
  check(envelope.schemaVersion, REQUEST_ENVELOPE_SCHEMA_VERSION, "request envelope schema must be explicit");
  check(envelope.headerNames, ["accept", "accept-language", "content-type", "origin", "referer", "user-agent"], "request header names must be exact");
  check(envelope.headerValuesStored, false, "request envelope must hash rather than store header values");
  check(envelope.bodyStored, false, "request envelope must hash rather than store the body");
  for (const [url, body] of [
    ["https://m.booking.naver.com/graphql", validBody],
    ["https://pcmap-api.place.naver.com/graphql?extra=1", validBody],
    ["https://pcmap-api.place.naver.com/graphql", { ...validBody, operationName: "searchBizItem" }],
    ["https://pcmap-api.place.naver.com/graphql", { ...validBody, variables: { id: placeId, isNx: true } }],
    ["https://pcmap-api.place.naver.com/graphql", { ...validBody, variables: { id: "1002", isNx: false } }]
  ]) {
    throws(
      () => assertGraphqlBoundary(url, { method: "POST", redirect: "manual", body: JSON.stringify(body) }, query, placeId),
      (error) => ["V2_BOOKING_BUSINESS_ENDPOINT_FORBIDDEN", "V2_BOOKING_BUSINESS_REQUEST_INVALID"].includes(error.code)
    );
  }
  for (const mutatedHeaders of [
    { ...validInit.headers, origin: "https://example.invalid" },
    { ...validInit.headers, cookie: "forbidden" },
    Object.fromEntries(Object.entries(validInit.headers).filter(([name]) => name !== "referer"))
  ]) {
    throws(
      () => requestEnvelope(
        "https://pcmap-api.place.naver.com/graphql",
        { ...validInit, headers: mutatedHeaders },
        validBody,
        placeId
      ),
      { code: "V2_BOOKING_BUSINESS_REQUEST_HEADERS_INVALID" },
      "any application request-header mutation must fail before fetch"
    );
  }

  const boundary = createOneShotFetchBoundary({
    mode: "fixture",
    placeId,
    expectedQuery: query,
    envelope: fixtureEnvelope("success", placeId),
    actualFetch: async () => { throw new Error("must not execute"); }
  });
  await boundary("https://pcmap-api.place.naver.com/graphql", validInit);
  await rejects(
    () => boundary("https://pcmap-api.place.naver.com/graphql", validInit),
    { code: "V2_BOOKING_BUSINESS_CALL_BUDGET_EXCEEDED" },
    "a second booking-business request must fail closed"
  );
  check(boundary.audit().callCount, 1, "failed second request must not increment the call count");

  const projection = {
    status: "succeeded",
    classification: "resolved",
    placeIdHash: sha256(placeId),
    bookingBusinessIdHash: sha256("9001"),
    bookingUrlPresent: true,
    providerConfirmedZero: false,
    providerErrors: false,
    providerStatus: 200,
    error: null,
    sourceFunctionDigest: "a".repeat(64),
    querySha256: "b".repeat(64),
    request: { operationName: "naverBookingBusiness" },
    calls: { bookingBusiness: 1, bookingItems: 0, dailySchedule: 0, total: 1, actualExternal: 0, fixture: 1 },
    retries: 0,
    fallbacks: 0,
    htmlFallbackCalls: 0,
    historicalFallbackReads: 0
  };
  check(compareTargets(projection, projection, projection, "offline").copiedExactParity, true, "equal offline projections must match exactly");
  check(compareTargets(projection, projection, { ...projection, classification: "zero" }, "live").copiedStructuralParity, false, "different live terminal classifications must not pass structurally");
  check(
    compareTargets(projection, projection, { ...projection, bookingBusinessIdHash: "c".repeat(64) }, "live").copiedStructuralParity,
    false,
    "different live booking identity hashes must not pass structurally"
  );
  check(
    compareTargets(projection, projection, { ...projection, providerStatus: 201 }, "live").copiedStructuralParity,
    false,
    "different live provider statuses must not pass structurally"
  );

  const sentinelValues = [
    "phase3-secret-sentinel-7c2e",
    "Authorization: Bearer phase3-forbidden-token",
    "X-Naver-Client-Secret: phase3-forbidden"
  ];
  process.env.V2_BOOKING_BUSINESS_FAKE_SECRET = sentinelValues[0];
  const pairRoot = isolatedRunRoot(baseJob.runId);
  await fs.rm(pairRoot, { recursive: true, force: true });
  const pair = await runPair(OFFLINE_JOB);
  check(pair.externalRequestCount, 0, "official offline pair must not call the network");
  check(pair.comparison.replayExactParity, true, "official replay must match exactly");
  check(pair.comparison.copiedStructuralParity, true, "official copied source must match structurally");
  check(pair.comparison.copiedExactParity, true, "official copied fixture must match exactly");
  check(pair.bookingBusinessRequests, 2, "original and copied fixture must each execute once");
  check(pair.bookingItemsRequests, 0, "pair must not call booking items");
  check(pair.dailyScheduleRequests, 0, "pair must not call schedules");
  await rejects(() => runPair(OFFLINE_JOB), { code: "V2_BOOKING_BUSINESS_RUN_EXISTS" }, "the same run ID must not execute twice");

  const files = await textFiles(pairRoot);
  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    for (const sentinel of sentinelValues) check(text.includes(sentinel), false, `secret-like value leaked into ${path.basename(file)}`);
    check(/<!doctype\s+html|<html|<body/iu.test(text), false, `raw HTML leaked into ${path.basename(file)}`);
  }

  const envelopeRunRoot = isolatedD1RunRoot("rebuild-phase3-booking-business-envelope-offline-001");
  await fs.rm(envelopeRunRoot, { recursive: true, force: true });
  const envelopeParity = await runEnvelopeParity(COPY_ONLY_JOB);
  check(envelopeParity.status, "passed", "D1 application-envelope parity must pass offline");
  check(envelopeParity.exactEnvelopeParity, true, "original and copied application envelopes must be byte-digest exact");
  check(envelopeParity.applicationEnvelopeSha256, COPY_ONLY_EXPECTED_ENVELOPE_SHA256, "D1 envelope must match the copy-only approval digest");
  check(envelopeParity.original.actualExternalRequests, 0, "D1 original envelope run must stay offline");
  check(envelopeParity.copied.actualExternalRequests, 0, "D1 copied envelope run must stay offline");
  await rejects(
    () => runEnvelopeParity(COPY_ONLY_JOB),
    { code: "V2_BOOKING_BUSINESS_RUN_EXISTS" },
    "D1 envelope evidence must not be overwritten"
  );

  const envelopeFiles = await textFiles(envelopeRunRoot);
  for (const file of envelopeFiles) {
    const text = await fs.readFile(file, "utf8");
    for (const sentinel of sentinelValues) check(text.includes(sentinel), false, `secret-like value leaked into ${path.basename(file)}`);
    check(/<!doctype\s+html|<html|<body/iu.test(text), false, `raw HTML leaked into ${path.basename(file)}`);
    check(text.includes(copyOnlyRead.job.placeId), false, `raw Place ID leaked into ${path.basename(file)}`);
  }
  delete process.env.V2_BOOKING_BUSINESS_FAKE_SECRET;

  const priorApproved = process.env.V2_BOOKING_BUSINESS_LIVE_APPROVED;
  const priorBudget = process.env.V2_BOOKING_BUSINESS_LIVE_REQUEST_BUDGET;
  const priorDigest = process.env.V2_BOOKING_BUSINESS_APPROVED_JOB_SHA256;
  const priorEnvelope = process.env.V2_BOOKING_BUSINESS_EXPECTED_ENVELOPE_SHA256;
  delete process.env.V2_BOOKING_BUSINESS_LIVE_APPROVED;
  delete process.env.V2_BOOKING_BUSINESS_LIVE_REQUEST_BUDGET;
  delete process.env.V2_BOOKING_BUSINESS_APPROVED_JOB_SHA256;
  delete process.env.V2_BOOKING_BUSINESS_EXPECTED_ENVELOPE_SHA256;
  await rejects(() => runPair(LIVE_JOB), { code: "V2_BOOKING_BUSINESS_PAIR_LIVE_CLOSED" }, "the previous live pair must remain permanently closed");
  const copyOnlyRunRoot = isolatedD1RunRoot(copyOnlyRead.job.runId);
  await fs.rm(copyOnlyRunRoot, { recursive: true, force: true });
  await rejects(
    () => runCopyOnlyLive(COPY_ONLY_JOB),
    { code: "V2_BOOKING_BUSINESS_LIVE_NOT_APPROVED" },
    "copy-only live must reject missing approval before creating evidence or networking"
  );
  check(await fs.stat(copyOnlyRunRoot).then(() => true, () => false), false, "a rejected copy-only gate must not create a run directory");
  if (priorApproved === undefined) delete process.env.V2_BOOKING_BUSINESS_LIVE_APPROVED; else process.env.V2_BOOKING_BUSINESS_LIVE_APPROVED = priorApproved;
  if (priorBudget === undefined) delete process.env.V2_BOOKING_BUSINESS_LIVE_REQUEST_BUDGET; else process.env.V2_BOOKING_BUSINESS_LIVE_REQUEST_BUDGET = priorBudget;
  if (priorDigest === undefined) delete process.env.V2_BOOKING_BUSINESS_APPROVED_JOB_SHA256; else process.env.V2_BOOKING_BUSINESS_APPROVED_JOB_SHA256 = priorDigest;
  if (priorEnvelope === undefined) delete process.env.V2_BOOKING_BUSINESS_EXPECTED_ENVELOPE_SHA256; else process.env.V2_BOOKING_BUSINESS_EXPECTED_ENVELOPE_SHA256 = priorEnvelope;

  check(guard.blockedAttempts(), 0, "fixture suite must not attempt external networking");
  const result = {
    schemaVersion: "v2-booking-business-test-result.v1",
    status: "passed",
    assertions,
    scenarios: [...ALLOWED_FIXTURE_SCENARIOS],
    externalRequests: 0,
    placeListRequests: 0,
    bookingBusinessFixtureCalls: ALLOWED_FIXTURE_SCENARIOS.size + 5,
    bookingItemsRequests: 0,
    dailyScheduleRequests: 0,
    htmlFallbackRequests: 0,
    historicalFallbackReads: 0,
    retries: 0,
    fallbacks: 0,
    operationalWrites: 0,
    rawProviderResponsesStored: false,
    applicationEnvelopeParity: true,
    previousLivePairClosed: true,
    copyOnlyLiveGateVerified: true
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);

  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ code: error?.code || "V2_BOOKING_BUSINESS_TEST_FAILED", message: error?.message || String(error) })}\n`);
  process.exitCode = 1;
}).finally(() => guard.restore());
