"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  ERROR_SCHEMA_VERSION,
  FIXED_HEADERS,
  JOB_SCHEMA_VERSION,
  LIVE_APPROVAL_NAME,
  REQUEST_ORIGIN,
  REQUEST_PATH,
  REQUEST_WHERE,
  RESULT_SCHEMA_VERSION,
  assertLiveApproval,
  buildRequestEnvelope,
  contentTypeClass,
  extractIntegratedSearchAdEvidence,
  jobApprovalDigest,
  normalizeJob,
  placeIdFromAdvertiserUrl,
  publicFailure,
  runIntegratedSearchAdDiagnostic,
  statusClass
} = require("./v2_naver_integrated_search_ad_diagnostic.cjs");

let assertions = 0;
function equal(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}
function deepEqual(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}
function ok(value, message) {
  assertions += 1;
  assert.ok(value, message);
}
function throws(fn, validator) {
  assertions += 1;
  assert.throws(fn, validator);
}
async function rejects(fn, validator) {
  assertions += 1;
  await assert.rejects(fn, validator);
}

function job(overrides = {}) {
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    runId: "n8-integrated-ad-offline-001",
    mode: "offline",
    keyword: "경남 글램핑",
    timeoutMs: 5000,
    responseSizeLimitBytes: 262144,
    requestBudget: 1,
    automaticRetries: 0,
    automaticFallbacks: 0,
    fixtureScenario: "visible-ads",
    ...overrides
  };
}

function fixtureTransport(body, options = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    const response = new Response(body, {
      status: options.status ?? 200,
      headers: {
        "content-type": options.contentType ?? "text/html; charset=utf-8",
        ...(options.contentLength === undefined ? {} : { "content-length": String(options.contentLength) })
      }
    });
    if (options.redirected) Object.defineProperty(response, "redirected", { value: true });
    return response;
  };
  return { calls, fetchImpl };
}

(async () => {
  const guard = installFixtureNetworkGuard({ label: "N8 integrated search ad diagnostic tests" });
  const fixtureRoot = path.resolve(__dirname, "..", "tests", "fixtures");
  const visibleHtml = fs.readFileSync(path.join(fixtureRoot, "v2_naver_integrated_search_visible_ads.sanitized.html"), "utf8");
  const emptyHtml = fs.readFileSync(path.join(fixtureRoot, "v2_naver_integrated_search_empty.sanitized.html"), "utf8");
  try {
    const normalized = normalizeJob(job());
    equal(normalized.schemaVersion, JOB_SCHEMA_VERSION);
    equal(normalized.mode, "offline");
    equal(normalized.keyword, "경남 글램핑");
    equal(normalized.requestBudget, 1);
    equal(normalized.automaticRetries, 0);
    equal(normalized.automaticFallbacks, 0);
    equal(normalized.fixtureScenario, "visible-ads");

    const envelope = buildRequestEnvelope(job());
    equal(envelope.method, "GET");
    equal(envelope.origin, REQUEST_ORIGIN);
    equal(envelope.path, REQUEST_PATH);
    deepEqual(envelope.queryParameterNames, ["where", "query"]);
    equal(envelope.where, REQUEST_WHERE);
    equal(envelope.keyword, "경남 글램핑");
    equal(envelope.redirect, "manual");
    equal(envelope.requestBudget, 1);
    deepEqual(envelope.headerNames, ["accept", "accept-language", "cache-control", "user-agent"]);
    equal(Object.hasOwn(FIXED_HEADERS, "cookie"), false);
    equal(Object.hasOwn(FIXED_HEADERS, "authorization"), false);
    ok(/^[a-f0-9]{64}$/u.test(jobApprovalDigest(job())));
    equal(jobApprovalDigest(job()), jobApprovalDigest({ ...job() }));

    equal(contentTypeClass("text/html; charset=utf-8"), "html");
    equal(contentTypeClass("application/xhtml+xml"), "xhtml");
    equal(contentTypeClass("application/json"), "other");
    equal(statusClass(200), "2xx");
    equal(statusClass(429), "4xx");
    equal(statusClass("invalid"), "unknown");

    equal(
      placeIdFromAdvertiserUrl("https://ader.naver.com/ad?fu=https%3A%2F%2Fmap.naver.com%2Fp%2Fentry%2Fplace%2F1000421329"),
      "1000421329"
    );
    equal(placeIdFromAdvertiserUrl("https://ader.naver.com/ad?fu=https%3A%2F%2Fevil.example%2Fplace%2F1000421329"), null);
    equal(placeIdFromAdvertiserUrl("https://map.naver.com/p/entry/place/1000421329"), null);

    const evidence = extractIntegratedSearchAdEvidence(visibleHtml);
    equal(evidence.collectionViable, true);
    equal(evidence.scannedContainerCount, 5);
    equal(evidence.candidateContainerCount, 4);
    equal(evidence.explicitAdLabelCount, 4);
    equal(evidence.advertiserLinkCount, 5);
    equal(evidence.duplicateLinkCount, 1);
    equal(evidence.uniquePlaceIdCount, 4);
    equal(evidence.namedPlaceCount, 4);
    equal(evidence.unnamedPlaceCount, 0);
    deepEqual(evidence.advertisements.map((row) => row.placeId), ["1000421329", "1995649140", "2092090019", "2000486899"]);
    deepEqual(evidence.advertisements.map((row) => row.name), ["합천H글램핑", "럭셔리 비토섬 제이글램핑", "옥돌캠핑장", "아르비토 호텔 글램핑"]);
    deepEqual(evidence.advertisements.map((row) => row.adOrder), [1, 2, 3, 4]);
    equal(extractIntegratedSearchAdEvidence(emptyHtml).collectionViable, false);
    equal(extractIntegratedSearchAdEvidence(emptyHtml).uniquePlaceIdCount, 0);

    const fixture = fixtureTransport(visibleHtml);
    const result = await runIntegratedSearchAdDiagnostic(job(), { fetchImpl: fixture.fetchImpl, environment: {} });
    equal(result.schemaVersion, RESULT_SCHEMA_VERSION);
    equal(result.event, "v2_naver_integrated_search_ad_diagnostic_complete");
    equal(result.status, "completed");
    equal(result.mode, "offline");
    equal(result.runId, "n8-integrated-ad-offline-001");
    equal(result.keyword, "경남 글램핑");
    equal(result.jobDigestSha256, jobApprovalDigest(job()));
    equal(result.response.status, 200);
    equal(result.response.httpStatusClass, "2xx");
    equal(result.response.contentTypeClass, "html");
    equal(result.response.parseStatus, "advertisements-observed");
    ok(result.response.responseBytes > 0);
    ok(/^[a-f0-9]{64}$/u.test(result.response.bodySha256));
    equal(result.evidence.uniquePlaceIdCount, 4);
    equal(result.audit.requestBudget, 1);
    equal(result.audit.requestAttempts, 1);
    equal(result.audit.fixtureRequests, 1);
    equal(result.audit.actualExternalRequests, 0);
    equal(result.audit.automaticRetries, 0);
    equal(result.audit.automaticFallbacks, 0);
    equal(result.audit.operationalWrites, 0);
    equal(result.audit.rawProviderResponseStored, false);
    equal(result.audit.cookiesSent, false);
    equal(result.audit.trackingUrlsStored, false);
    equal(fixture.calls.length, 1);
    equal(fixture.calls[0].input, "https://search.naver.com/search.naver?where=nexearch&query=%EA%B2%BD%EB%82%A8+%EA%B8%80%EB%9E%A8%ED%95%91");
    equal(fixture.calls[0].init.method, "GET");
    equal(fixture.calls[0].init.redirect, "manual");
    equal(fixture.calls[0].init.body, undefined);
    ok(fixture.calls[0].init.signal instanceof AbortSignal);
    equal(Object.hasOwn(fixture.calls[0].init.headers, "cookie"), false);

    const empty = fixtureTransport(emptyHtml);
    const emptyResult = await runIntegratedSearchAdDiagnostic(job({
      runId: "n8-integrated-ad-offline-002",
      fixtureScenario: "empty"
    }), { fetchImpl: empty.fetchImpl, environment: {} });
    equal(emptyResult.response.parseStatus, "no-viable-advertisements");
    equal(emptyResult.evidence.collectionViable, false);
    equal(empty.calls.length, 1);

    const liveJob = job({
      runId: "n8-integrated-ad-live-001",
      mode: "live",
      fixtureScenario: "none"
    });
    throws(() => assertLiveApproval(liveJob, {}), (error) => error?.code === "V2_N8_LIVE_APPROVAL_REQUIRED");
    equal(assertLiveApproval(liveJob, {
      V2_N8_INTEGRATED_AD_LIVE_APPROVED: LIVE_APPROVAL_NAME,
      V2_N8_INTEGRATED_AD_REQUEST_BUDGET: "1",
      V2_N8_INTEGRATED_AD_APPROVED_JOB_SHA256: jobApprovalDigest(liveJob)
    }), true);
    throws(() => normalizeJob({ ...job(), extra: true }), (error) => error?.code === "V2_N8_JOB_INVALID");
    throws(() => normalizeJob(job({ requestBudget: 2 })), (error) => error?.code === "V2_N8_JOB_INVALID");
    throws(() => normalizeJob(job({ automaticRetries: 1 })), (error) => error?.code === "V2_N8_JOB_INVALID");
    throws(() => normalizeJob(job({ automaticFallbacks: 1 })), (error) => error?.code === "V2_N8_JOB_INVALID");
    throws(() => normalizeJob(job({ keyword: "<script>" })), (error) => error?.code === "V2_N8_JOB_INVALID");
    throws(() => extractIntegratedSearchAdEvidence(""), (error) => error?.code === "V2_N8_HTML_INVALID");
    await rejects(
      () => runIntegratedSearchAdDiagnostic(job({ runId: "n8-integrated-ad-offline-no-transport" }), { environment: {} }),
      (error) => error?.code === "V2_N8_OFFLINE_TRANSPORT_REQUIRED"
    );

    const wrongType = fixtureTransport("{}", { contentType: "application/json" });
    await rejects(
      () => runIntegratedSearchAdDiagnostic(job({ runId: "n8-integrated-ad-offline-003" }), { fetchImpl: wrongType.fetchImpl, environment: {} }),
      (error) => error?.code === "V2_N8_CONTENT_TYPE_INVALID"
    );
    equal(wrongType.calls.length, 1);

    const serverError = fixtureTransport("<html>error</html>", { status: 500 });
    await rejects(
      () => runIntegratedSearchAdDiagnostic(job({ runId: "n8-integrated-ad-offline-004" }), { fetchImpl: serverError.fetchImpl, environment: {} }),
      (error) => error?.code === "V2_N8_HTTP_ERROR"
    );
    equal(serverError.calls.length, 1);

    const redirected = fixtureTransport("redirect", { status: 302 });
    await rejects(
      () => runIntegratedSearchAdDiagnostic(job({ runId: "n8-integrated-ad-offline-005" }), { fetchImpl: redirected.fetchImpl, environment: {} }),
      (error) => error?.code === "V2_N8_REDIRECTED"
    );
    equal(redirected.calls.length, 1);

    const oversized = fixtureTransport(visibleHtml, { contentLength: 300000 });
    await rejects(
      () => runIntegratedSearchAdDiagnostic(job({ runId: "n8-integrated-ad-offline-006", responseSizeLimitBytes: 262144 }), {
        fetchImpl: oversized.fetchImpl,
        environment: {}
      }),
      (error) => error?.code === "V2_N8_RESPONSE_TOO_LARGE_OR_INVALID"
    );
    equal(oversized.calls.length, 1);

    const challenged = fixtureTransport("<!doctype html><html><body>captcha verification</body></html>");
    await rejects(
      () => runIntegratedSearchAdDiagnostic(job({ runId: "n8-integrated-ad-offline-007" }), { fetchImpl: challenged.fetchImpl, environment: {} }),
      (error) => error?.code === "V2_N8_ACCESS_BLOCKED"
    );
    equal(challenged.calls.length, 1);

    const timeoutFetch = (_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    });
    await rejects(
      () => runIntegratedSearchAdDiagnostic(job({ runId: "n8-integrated-ad-offline-008", timeoutMs: 500 }), {
        fetchImpl: timeoutFetch,
        environment: {}
      }),
      (error) => error?.code === "V2_N8_TIMEOUT"
    );

    const sentinel = "n8-secret-sentinel-must-not-leak";
    const failure = publicFailure({
      code: "V2_N8_ACCESS_BLOCKED",
      stage: "provider-response",
      message: sentinel,
      details: {
        requestBudget: 1,
        requestAttempts: 1,
        fixtureRequests: 1,
        actualExternalRequests: 0,
        automaticRetries: 0,
        automaticFallbacks: 0,
        operationalWrites: 0,
        rawProviderResponseStored: false,
        rawBody: sentinel,
        cookie: sentinel
      }
    });
    equal(failure.schemaVersion, ERROR_SCHEMA_VERSION);
    equal(failure.status, "failed");
    equal(failure.retryable, false);
    equal(JSON.stringify(failure).includes(sentinel), false);
    equal(Object.hasOwn(failure.diagnostic, "rawBody"), false);
    equal(Object.hasOwn(failure.diagnostic, "cookie"), false);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "v2-n8-diagnostic-"));
    const jobPath = path.join(tempRoot, "job.json");
    fs.writeFileSync(jobPath, `${JSON.stringify(job())}\n`, { encoding: "utf8", flag: "wx" });
    const child = spawnSync(process.execPath, [
      path.resolve(__dirname, "v2_naver_integrated_search_ad_diagnostic.cjs"),
      "--job",
      jobPath
    ], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      env: { PATH: process.env.PATH || "" }
    });
    equal(child.status, 0);
    equal(child.stderr, "");
    const childResult = JSON.parse(child.stdout.trim());
    equal(childResult.status, "completed");
    equal(childResult.evidence.uniquePlaceIdCount, 4);
    equal(childResult.audit.actualExternalRequests, 0);
    equal(childResult.audit.operationalWrites, 0);
    fs.rmSync(tempRoot, { recursive: true, force: true });

    equal(guard.blockedAttempts(), 0);
    process.stdout.write(`${JSON.stringify({
      event: "v2_naver_integrated_search_ad_diagnostic_tests_complete",
      assertions,
      externalRequests: 0,
      operationalWrites: 0,
      rawProviderResponsesStored: 0
    })}\n`);
  } finally {
    guard.restore();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
