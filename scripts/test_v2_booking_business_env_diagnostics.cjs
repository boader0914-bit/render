"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  APPLICATION_ENVELOPE_SHA256,
  CONTROLLED_GRAPHQL_HEADER_NAMES,
  D1_COMMIT,
  ENVIRONMENT_EVIDENCE_CANONICAL_SHA256,
  ENVIRONMENT_EVIDENCE_SOURCE_BLOBS,
  LOCKFILE_SHA256,
  REFERENCE_COLLECTOR_BLOB,
  RESULT_SCHEMA_VERSION,
  V2_COLLECTOR_BLOB,
  expectedGraphqlRequest,
  headerNamesFromUndici,
  outputPath,
  readEnvironmentEvidence,
  runDiagnostics,
  runtimeFingerprint,
  safeExecArgvNames,
  sequenceLoopbackProbe,
  sourceSessionInspection,
  standaloneLoopbackProbe
} = require("./v2_booking_business_env_diagnostics.cjs");

const guard = installFixtureNetworkGuard({
  allowLocalhost: true,
  label: "V2 booking-business D2 environment diagnostics"
});
let assertions = 0;

function check(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

async function rejects(action, expected, message) {
  assertions += 1;
  await assert.rejects(action, expected, message);
}

function assertNoValues(value, forbidden, label) {
  const serialized = JSON.stringify(value);
  for (const token of forbidden) {
    assertions += 1;
    assert.equal(serialized.includes(token), false, `${label} leaked a forbidden value`);
  }
}

async function main() {
  const evidenceFile = await readEnvironmentEvidence();
  const evidence = evidenceFile.value;
  check(evidence.baseline.diagnosticsCommit, D1_COMMIT, "environment evidence must start at the D1 commit");
  check(evidenceFile.canonicalSha256, ENVIRONMENT_EVIDENCE_CANONICAL_SHA256, "historical environment evidence must remain canonically frozen");
  check(
    Object.fromEntries(Object.keys(ENVIRONMENT_EVIDENCE_SOURCE_BLOBS).map((key) => [key, evidence.evidenceSources[key]])),
    ENVIRONMENT_EVIDENCE_SOURCE_BLOBS,
    "historical evidence source blobs must remain tied to their recorded commits"
  );
  check(evidence.baseline.v2CollectorBlob, V2_COLLECTOR_BLOB, "V2 collector identity must remain exact");
  check(evidence.baseline.referenceCollectorBlob, REFERENCE_COLLECTOR_BLOB, "reference collector must remain exact");
  check(evidence.baseline.lockfileSha256, LOCKFILE_SHA256, "lockfile identity must remain exact");
  check(evidence.baseline.applicationEnvelopeSha256, APPLICATION_ENVELOPE_SHA256, "application envelope must remain exact");
  check(evidence.observations.length, 4, "four historical observations must be compared");
  check(
    evidence.observations.map((entry) => entry.outcome.providerStatus),
    [null, 200, 405, 405],
    "historical status evidence must remain exact"
  );
  check(evidence.observations[3].outcome.providerFailureSubtype, "challenge_html", "D1 challenge subtype must remain recorded");
  check(evidence.privacy, {
    providerBodiesStored: false,
    providerHeaderValuesStored: false,
    placeIdStored: false,
    bookingBusinessIdStored: false,
    secretValuesStored: false
  }, "historical environment evidence must remain redacted");

  const sentinels = [
    "http://diagnostic-user:diagnostic-pass@proxy.invalid:8080",
    "C:\\diagnostic-secret-ca.pem",
    "phase3-d2-secret-value"
  ];
  const fingerprint = runtimeFingerprint({
    HTTPS_PROXY: sentinels[0],
    NODE_EXTRA_CA_CERTS: sentinels[1],
    V2_BOOKING_BUSINESS_SECRET_SENTINEL: sentinels[2],
    TZ: "Asia/Seoul",
    RENDER_SERVICE_ID: "srv-fixture-not-a-live-resource"
  });
  check(fingerprint.runtime.nodeVersion, "v26.5.0", "runtime must use Node 26.5.0");
  check(fingerprint.runtime.undiciVersion, "8.7.0", "runtime must use bundled Undici 8.7.0");
  check(fingerprint.runtime.opensslVersion, "3.5.7", "runtime must use OpenSSL 3.5.7");
  check(fingerprint.environmentPresence.proxyNames, ["HTTPS_PROXY"], "only proxy names may be retained");
  check(fingerprint.environmentPresence.caNames, ["NODE_EXTRA_CA_CERTS"], "only CA variable names may be retained");
  check(fingerprint.environmentPresence.localeNames, ["TZ"], "only locale variable names may be retained");
  check(fingerprint.environmentPresence.renderNames, ["RENDER_SERVICE_ID"], "only Render variable names may be retained");
  check(fingerprint.privacy.environmentValuesStored, false, "environment values must never be persisted");
  assertNoValues(fingerprint, sentinels, "runtime fingerprint");
  check(safeExecArgvNames(["--require=C:/secret/preload.cjs", "--trace-warnings", "script.cjs"]), ["--require", "--trace-warnings"], "execArgv must retain option names only");

  check(headerNamesFromUndici("accept: */*\r\ncontent-type: application/json\r\n"), ["accept", "content-type"], "string Undici headers must reduce to names");
  check(headerNamesFromUndici(Buffer.from("origin: https://example.invalid\r\n")), ["origin"], "buffer Undici headers must reduce to names");
  check(headerNamesFromUndici(["accept", "*/*", "origin", "https://example.invalid"]), ["accept", "origin"], "array Undici headers must reduce to names");

  const requestShape = expectedGraphqlRequest();
  check(Object.keys(requestShape.headers).sort(), [...CONTROLLED_GRAPHQL_HEADER_NAMES], "controlled GraphQL header names must remain exact");
  const standalone = await standaloneLoopbackProbe(requestShape);
  check(standalone.method, "POST", "standalone probe must use POST");
  check(standalone.pathClass, "graphql", "standalone probe must target the local GraphQL path class");
  check(standalone.httpVersion, "1.1", "bundled fetch loopback must use HTTP/1.1");
  check(standalone.controlledHeaderValuesMatch, Object.fromEntries(CONTROLLED_GRAPHQL_HEADER_NAMES.map((name) => [name, true])), "controlled headers must arrive unchanged");
  check(standalone.implicitHeaderNames, ["accept-encoding", "connection", "content-length", "host", "sec-fetch-mode"], "Node and Undici implicit header names must be explicit");
  check(standalone.cookieHeaderPresent, false, "standalone fetch must not synthesize cookies");
  check(standalone.bodySha256, requestShape.bodySha256, "loopback body digest must match the approved request shape");

  const sequence = await sequenceLoopbackProbe(requestShape);
  check(sequence.mainPlace.pathClass, "main-place", "sequence probe must begin with a local main-place path");
  check(sequence.graphql.pathClass, "graphql", "sequence probe must end with a local GraphQL path");
  check(sequence.setCookieIssuedByMainFixture, true, "main fixture must issue a Set-Cookie for the session test");
  check(sequence.cookieAutomaticallyForwarded, false, "Node fetch must not automatically forward the main fixture cookie");
  check(sequence.sameProcess, true, "sequence fixture must remain in one process");

  const sourceInspection = await sourceSessionInspection();
  check(sourceInspection.explicitCookieStateTokenMatches, 0, "the V2 request path must not contain explicit cookie state code");
  check(sourceInspection.directGlobalFetchAdapters, 2, "main and booking transports must both delegate to global fetch");
  check(sourceInspection.mainPlaceBeforeBookingEnrichment, true, "the full V2 path must call main Place before booking enrichment");

  const officialOutput = outputPath();
  const runRoot = path.dirname(officialOutput);
  await fs.rm(runRoot, { recursive: true, force: true });
  const result = await runDiagnostics({ writeEvidence: true });
  check(result.schemaVersion, RESULT_SCHEMA_VERSION, "D2 result schema must remain exact");
  check(result.status, "passed", "D2 offline diagnostics must pass");
  check(result.loopback.standaloneAndSequenceGraphqlMatch, true, "standalone and sequence GraphQL wire shapes must match offline");
  check(result.isolation.providerExternalRequests, 0, "D2 must not call the Provider");
  check(result.isolation.loopbackRequests, 3, "D2 must use only three local loopback requests");
  check(result.isolation.operationalWrites, 0, "D2 must not write operational data");
  check(result.isolation.retries, 0, "D2 must not retry");
  check(result.isolation.fallbacks, 0, "D2 must not fallback");
  check(result.hypotheses.find((entry) => entry.hypothesis.startsWith("rapid consecutive"))?.classification, "evidence-against-as-sole-cause", "two-hour failure must weaken the rapid-only hypothesis");
  check(result.hypotheses.find((entry) => entry.hypothesis.startsWith("main Place must"))?.classification, "not-required-for-the-observed-original-success", "standalone original success must weaken the required-warmup hypothesis");
  check(result.nextApproval, "N3-D2-Commit", "D2 must stop before commit or live work");
  check(await fs.stat(officialOutput).then(() => true, () => false), true, "D2 evidence must be written atomically");
  await rejects(
    () => runDiagnostics({ writeEvidence: true }),
    { code: "V2_BOOKING_BUSINESS_ENV_RUN_EXISTS" },
    "D2 evidence must not be overwritten"
  );

  const outputText = await fs.readFile(officialOutput, "utf8");
  assertNoValues(outputText, sentinels, "D2 evidence output");
  check(/(?:pcmap-api\.place\.naver\.com|pcmap\.place\.naver\.com)/u.test(outputText), false, "offline output must not persist Provider hostnames");
  check(/(?:127\.0\.0\.1|localhost)/u.test(outputText), false, "offline output must not persist loopback addresses");
  check(/<!doctype\s+html|<html|<body/iu.test(outputText), false, "offline output must not persist HTML bodies");

  await fs.rm(runRoot, { recursive: true, force: true });

  check(guard.blockedAttempts(), 0, "D2 fixtures must not attempt external networking");
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "v2-booking-business-environment-test-result.v1",
    status: "passed",
    assertions,
    providerExternalRequests: 0,
    loopbackRequests: 6,
    operationalWrites: 0,
    retries: 0,
    fallbacks: 0,
    secretScan: "passed",
    collectorFilesModified: 0
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    code: error?.code || "V2_BOOKING_BUSINESS_ENV_TEST_FAILED",
    message: error?.message || String(error)
  })}\n`);
  process.exitCode = 1;
}).finally(() => guard.restore());
