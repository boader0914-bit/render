"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  ACCESS_DIAGNOSTIC_SCHEMA_VERSION,
  ERROR_SCHEMA_VERSION,
  JOB_SCHEMA_VERSION,
  LIVE_APPROVAL_NAME,
  ONE_SHOT_SCHEMA_VERSION,
  PROVIDER_MARKER_SELECTOR,
  REQUEST_ORIGIN,
  ROOM_HEADER_SELECTOR,
  SELECTOR_VERSION,
  allowedJobPath,
  assertLiveApproval,
  buildRequestEnvelope,
  contentTypeClass,
  decodeHtmlText,
  extractRoomSectionsFromPlaceHtml,
  jobApprovalDigest,
  normalizeJob,
  runRoomProviderMarkerLiveOneShot,
  serializeTerminalError
} = require("./v2_naver_place_room_provider_marker_live_one_shot.cjs");

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
async function rejection(fn) {
  let captured = null;
  try {
    await fn();
  } catch (error) {
    captured = error;
  }
  ok(captured, "Expected the operation to reject");
  return captured;
}

function job(overrides = {}) {
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    runId: "n5-room-marker-offline-001",
    mode: "offline",
    placeId: "1460523479",
    timeoutMs: 5000,
    responseSizeLimitBytes: 262144,
    requestBudget: 1,
    automaticRetries: 0,
    automaticFallbacks: 0,
    fixtureScenario: "success",
    ...overrides
  };
}

function html(heading = "객실6", marker = "[캠핑톡]", options = {}) {
  const markerNode = marker === null ? "" : `<span class="place_section_header_extra">${marker}</span>`;
  const second = options.second || "";
  return `<!doctype html><html><body>
    <h2 class="unrelated_heading">안내</h2>
    <h2 data-testid="rooms" class="place_section_header section_title"><span>${heading}</span>${markerNode}</h2>
    ${second}
  </body></html>`;
}

function fixtureTransport(body, options = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    const response = new Response(body, {
      status: options.status ?? 200,
      headers: {
        "content-type": options.contentType ?? "text/html; charset=utf-8",
        ...(options.contentLength === undefined ? {} : { "content-length": String(options.contentLength) }),
        ...(options.headers || {})
      }
    });
    if (options.url) Object.defineProperty(response, "url", { value: options.url });
    if (options.redirected) Object.defineProperty(response, "redirected", { value: true });
    return response;
  };
  return { calls, fetchImpl };
}

(async () => {
  const guard = installFixtureNetworkGuard({ label: "N5-D3 room marker access diagnostics tests" });
  try {
    const fixtureFile = path.resolve(__dirname, "..", "tests", "fixtures", "v2_naver_place_room_provider_marker_positive.sanitized.html");
    const fixtureHtml = fs.readFileSync(fixtureFile, "utf8");
    const normalized = normalizeJob(job());
    equal(normalized.schemaVersion, JOB_SCHEMA_VERSION);
    equal(normalized.mode, "offline");
    equal(normalized.placeId, "1460523479");
    equal(normalized.requestBudget, 1);
    equal(normalized.automaticRetries, 0);
    equal(normalized.automaticFallbacks, 0);

    const envelope = buildRequestEnvelope(job());
    equal(envelope.method, "GET");
    equal(envelope.origin, REQUEST_ORIGIN);
    equal(envelope.path, "/accommodation/1460523479/home");
    deepEqual(envelope.queryParameterNames, []);
    equal(envelope.redirect, "manual");
    equal(envelope.requestBudget, 1);
    equal(envelope.selectors.version, SELECTOR_VERSION);
    equal(envelope.selectors.roomHeader, ROOM_HEADER_SELECTOR);
    equal(envelope.selectors.providerMarker, PROVIDER_MARKER_SELECTOR);
    ok(/^[a-f0-9]{64}$/u.test(jobApprovalDigest(job())));
    equal(jobApprovalDigest(job()), jobApprovalDigest({ ...job() }));
    equal(contentTypeClass("text/html; charset=utf-8"), "html");
    equal(contentTypeClass("application/xhtml+xml"), "xhtml");
    equal(contentTypeClass("application/json"), "other");

    equal(decodeHtmlText(" <span>객실&nbsp;6</span> "), "객실 6");
    equal(decodeHtmlText("[캠핑&#53665;]"), "[캠핑톡]");
    const extracted = extractRoomSectionsFromPlaceHtml(fixtureHtml);
    equal(extracted.length, 1);
    deepEqual(extracted[0], {
      sectionKind: "room_header",
      headingText: "객실6",
      extraText: "[캠핑톡]"
    });
    deepEqual(extractRoomSectionsFromPlaceHtml(html("객실 6", null))[0], {
      sectionKind: "room_header",
      headingText: "객실 6",
      extraText: ""
    });
    equal(extractRoomSectionsFromPlaceHtml(html("객실7", "【ONDA】"))[0].extraText, "【ONDA】");

    const fixture = fixtureTransport(fixtureHtml, {
      url: "https://pcmap.place.naver.com/accommodation/1460523479/home"
    });
    const result = await runRoomProviderMarkerLiveOneShot(job(), { fetchImpl: fixture.fetchImpl });
    equal(result.schemaVersion, ONE_SHOT_SCHEMA_VERSION);
    equal(result.runId, "n5-room-marker-offline-001");
    equal(result.mode, "offline");
    equal(result.placeId, "1460523479");
    equal(result.jobDigestSha256, jobApprovalDigest(job()));
    equal(result.request.method, "GET");
    equal(result.request.origin, REQUEST_ORIGIN);
    equal(result.request.path, "/accommodation/1460523479/home");
    equal(result.request.selectorVersion, SELECTOR_VERSION);
    equal(result.response.status, 200);
    equal(result.response.contentTypeClass, "html");
    equal(result.response.parseStatus, "parsed");
    ok(result.response.responseBytes > 0);
    equal(result.observation.roomCount, 6);
    equal(result.observation.providerMarker.displayText, "[캠핑톡]");
    equal(result.observation.providerMarker.standardChannelId, "campingtalk");
    equal(result.observation.providerMarker.standardChannelName, "캠핑톡");
    equal(result.observation.evidence.level, "high");
    equal(result.observation.evidence.type, "explicit_room_header_provider_marker");
    equal(result.audit.requestBudget, 1);
    equal(result.audit.requestAttempts, 1);
    equal(result.audit.fixtureRequests, 1);
    equal(result.audit.actualExternalRequests, 0);
    equal(result.audit.automaticRetries, 0);
    equal(result.audit.automaticFallbacks, 0);
    equal(result.audit.operationalWrites, 0);
    equal(result.audit.rawProviderResponseStored, false);
    equal(fixture.calls.length, 1);
    equal(fixture.calls[0].input, "https://pcmap.place.naver.com/accommodation/1460523479/home");
    equal(fixture.calls[0].init.method, "GET");
    equal(fixture.calls[0].init.redirect, "manual");
    equal(fixture.calls[0].init.body, undefined);
    ok(fixture.calls[0].init.signal instanceof AbortSignal);
    equal(typeof fixture.calls[0].init.headers["user-agent"], "string");

    const noMarker = fixtureTransport(html("객실6", null));
    const noMarkerResult = await runRoomProviderMarkerLiveOneShot(job({ runId: "n5-room-marker-offline-002" }), {
      fetchImpl: noMarker.fetchImpl
    });
    equal(noMarkerResult.observation.providerMarker.mappingStatus, "absent");
    equal(noMarkerResult.observation.providerMarker.standardChannelId, null);
    equal(noMarkerResult.observation.evidence.level, "medium");

    const unknown = fixtureTransport(html("객실6", "[새공급자]"));
    const unknownResult = await runRoomProviderMarkerLiveOneShot(job({ runId: "n5-room-marker-offline-003" }), {
      fetchImpl: unknown.fetchImpl
    });
    equal(unknownResult.observation.providerMarker.mappingStatus, "unmapped");
    equal(unknownResult.observation.providerMarker.standardChannelId, null);
    equal(unknownResult.observation.evidence.level, "medium");

    throws(() => normalizeJob({ ...job(), unexpected: true }), (error) => error?.code === "V2_NAVER_ROOM_MARKER_LIVE_JOB_INVALID");
    throws(() => normalizeJob(job({ requestBudget: 2 })), (error) => error?.code === "V2_NAVER_ROOM_MARKER_LIVE_JOB_INVALID");
    throws(() => normalizeJob(job({ automaticRetries: 1 })), (error) => error?.code === "V2_NAVER_ROOM_MARKER_LIVE_JOB_INVALID");
    throws(() => normalizeJob(job({ automaticFallbacks: 1 })), (error) => error?.code === "V2_NAVER_ROOM_MARKER_LIVE_JOB_INVALID");
    throws(() => normalizeJob(job({ placeId: "place-1460523479" })), (error) => error?.code === "V2_NAVER_ROOM_MARKER_LIVE_JOB_INVALID");
    throws(() => extractRoomSectionsFromPlaceHtml("<html><body>no room selector</body></html>"), (error) => error?.code === "V2_NAVER_ROOM_MARKER_SELECTOR_MISMATCH");
    throws(() => extractRoomSectionsFromPlaceHtml("<h2 class=\"place_section_header\">객실</h2>"), (error) => error?.code === "V2_NAVER_ROOM_MARKER_SELECTOR_MISMATCH");
    throws(() => extractRoomSectionsFromPlaceHtml(
      '<h2 class="place_section_header"><span>객실6</span><span class="place_section_header_extra">[캠핑톡]</span><span class="place_section_header_extra">[ONDA]</span></h2>'
    ), (error) => error?.code === "V2_NAVER_ROOM_MARKER_DOM_AMBIGUOUS");

    const conflicting = fixtureTransport(html("객실6", "[캠핑톡]", {
      second: '<h2 class="place_section_header"><span>객실7</span><span class="place_section_header_extra">[캠핑톡]</span></h2>'
    }));
    await rejects(
      () => runRoomProviderMarkerLiveOneShot(job({ runId: "n5-room-marker-offline-004" }), { fetchImpl: conflicting.fetchImpl }),
      (error) => error?.code === "V2_NAVER_ROOM_MARKER_AMBIGUOUS"
    );
    equal(conflicting.calls.length, 1);

    const redirected = fixtureTransport("redirect", { status: 302, contentType: "text/html" });
    await rejects(
      () => runRoomProviderMarkerLiveOneShot(job({ runId: "n5-room-marker-offline-005" }), { fetchImpl: redirected.fetchImpl }),
      (error) => error?.code === "V2_NAVER_ROOM_MARKER_REDIRECTED"
    );
    equal(redirected.calls.length, 1);

    const redirectedFlag = fixtureTransport(fixtureHtml, { redirected: true });
    await rejects(
      () => runRoomProviderMarkerLiveOneShot(job({ runId: "n5-room-marker-offline-006" }), { fetchImpl: redirectedFlag.fetchImpl }),
      (error) => error?.code === "V2_NAVER_ROOM_MARKER_REDIRECTED"
    );

    const secretSentinel = "n5-secret-sentinel-must-not-leak";
    const blockedBody = `<html><body>captcha challenge ${secretSentinel}</body></html>`;
    const blocked = fixtureTransport(blockedBody, {
      status: 403,
      headers: {
        "set-cookie": `session=${secretSentinel}`,
        "x-private-value": secretSentinel
      }
    });
    const blockedError = await rejection(
      () => runRoomProviderMarkerLiveOneShot(job({ runId: "n5-room-marker-offline-007" }), { fetchImpl: blocked.fetchImpl })
    );
    equal(blockedError.code, "V2_NAVER_ROOM_MARKER_ACCESS_BLOCKED");
    deepEqual(blockedError.diagnostic, {
      schemaVersion: ACCESS_DIAGNOSTIC_SCHEMA_VERSION,
      blockSubtype: "http_403",
      httpStatusClass: "4xx",
      contentTypeClass: "html",
      responseBytes: Buffer.byteLength(blockedBody, "utf8"),
      retryAfterPresent: false,
      requestAttempts: 1,
      fixtureRequests: 1,
      actualExternalRequests: 0,
      automaticRetries: 0,
      automaticFallbacks: 0,
      operationalWrites: 0,
      rawProviderResponseStored: false
    });
    const blockedTerminal = serializeTerminalError(blockedError);
    equal(blockedTerminal.schemaVersion, ERROR_SCHEMA_VERSION);
    equal(blockedTerminal.status, "failed");
    equal(blockedTerminal.code, "V2_NAVER_ROOM_MARKER_ACCESS_BLOCKED");
    equal(blockedTerminal.retryable, false);
    deepEqual(blockedTerminal.diagnostic, blockedError.diagnostic);
    deepEqual(Object.keys(blockedTerminal).sort(), ["code", "diagnostic", "retryable", "schemaVersion", "status"]);
    deepEqual(Object.keys(blockedTerminal.diagnostic).sort(), [
      "actualExternalRequests",
      "automaticFallbacks",
      "automaticRetries",
      "blockSubtype",
      "contentTypeClass",
      "fixtureRequests",
      "httpStatusClass",
      "operationalWrites",
      "rawProviderResponseStored",
      "requestAttempts",
      "responseBytes",
      "retryAfterPresent",
      "schemaVersion"
    ]);
    const blockedTerminalText = JSON.stringify(blockedTerminal);
    equal(blockedTerminalText.includes(secretSentinel), false);
    equal(blockedTerminalText.includes("set-cookie"), false);
    equal(blockedTerminalText.includes("x-private-value"), false);
    equal(blockedTerminalText.includes("captcha challenge"), false);

    const rateLimitedBody = "<html><body>rate limited</body></html>";
    const rateLimited = fixtureTransport(rateLimitedBody, {
      status: 429,
      headers: {
        "retry-after": "120",
        "x-private-value": secretSentinel
      }
    });
    const rateLimitedError = await rejection(
      () => runRoomProviderMarkerLiveOneShot(job({ runId: "n5-room-marker-offline-013" }), { fetchImpl: rateLimited.fetchImpl })
    );
    equal(rateLimitedError.code, "V2_NAVER_ROOM_MARKER_ACCESS_BLOCKED");
    equal(rateLimitedError.diagnostic.blockSubtype, "http_429");
    equal(rateLimitedError.diagnostic.httpStatusClass, "4xx");
    equal(rateLimitedError.diagnostic.contentTypeClass, "html");
    equal(rateLimitedError.diagnostic.responseBytes, Buffer.byteLength(rateLimitedBody, "utf8"));
    equal(rateLimitedError.diagnostic.retryAfterPresent, true);
    equal(rateLimitedError.diagnostic.requestAttempts, 1);
    equal(rateLimitedError.diagnostic.fixtureRequests, 1);
    equal(rateLimitedError.diagnostic.actualExternalRequests, 0);
    equal(JSON.stringify(serializeTerminalError(rateLimitedError)).includes("120"), false);
    equal(JSON.stringify(serializeTerminalError(rateLimitedError)).includes(secretSentinel), false);

    const challengeBody = "<!doctype html><html><body>captcha verification</body></html>";
    const challenged = fixtureTransport(challengeBody, {
      status: 200,
      contentType: "application/xhtml+xml; charset=utf-8"
    });
    const challengedError = await rejection(
      () => runRoomProviderMarkerLiveOneShot(job({ runId: "n5-room-marker-offline-014" }), { fetchImpl: challenged.fetchImpl })
    );
    equal(challengedError.code, "V2_NAVER_ROOM_MARKER_ACCESS_BLOCKED");
    equal(challengedError.diagnostic.blockSubtype, "challenge_html");
    equal(challengedError.diagnostic.httpStatusClass, "2xx");
    equal(challengedError.diagnostic.contentTypeClass, "xhtml");
    equal(challengedError.diagnostic.responseBytes, Buffer.byteLength(challengeBody, "utf8"));
    equal(challengedError.diagnostic.retryAfterPresent, false);
    equal(challengedError.diagnostic.operationalWrites, 0);
    equal(challengedError.diagnostic.rawProviderResponseStored, false);

    const safeGenericTerminal = serializeTerminalError(new Error(`Bearer ${secretSentinel}`));
    equal(safeGenericTerminal.schemaVersion, ERROR_SCHEMA_VERSION);
    equal(safeGenericTerminal.code, "V2_NAVER_ROOM_MARKER_LIVE_FAILED");
    equal(Object.hasOwn(safeGenericTerminal, "diagnostic"), false);
    equal(JSON.stringify(safeGenericTerminal).includes(secretSentinel), false);
    const poisonedTerminal = serializeTerminalError({
      code: "V2_NAVER_ROOM_MARKER_ACCESS_BLOCKED",
      diagnostic: { ...blockedError.diagnostic, rawBody: secretSentinel }
    });
    equal(Object.hasOwn(poisonedTerminal, "diagnostic"), false);
    equal(JSON.stringify(poisonedTerminal).includes(secretSentinel), false);
    const writeClaimTerminal = serializeTerminalError({
      code: "V2_NAVER_ROOM_MARKER_ACCESS_BLOCKED",
      diagnostic: { ...blockedError.diagnostic, operationalWrites: 1 }
    });
    equal(Object.hasOwn(writeClaimTerminal, "diagnostic"), false);

    const wrongType = fixtureTransport("{}", { contentType: "application/json" });
    await rejects(
      () => runRoomProviderMarkerLiveOneShot(job({ runId: "n5-room-marker-offline-008" }), { fetchImpl: wrongType.fetchImpl }),
      (error) => error?.code === "V2_NAVER_ROOM_MARKER_CONTENT_TYPE_INVALID"
    );

    const serverError = fixtureTransport("<html><body>error</body></html>", { status: 500 });
    await rejects(
      () => runRoomProviderMarkerLiveOneShot(job({ runId: "n5-room-marker-offline-009" }), { fetchImpl: serverError.fetchImpl }),
      (error) => error?.code === "V2_NAVER_ROOM_MARKER_HTTP_ERROR"
    );

    const tooLarge = fixtureTransport(fixtureHtml, { contentLength: 300000 });
    await rejects(
      () => runRoomProviderMarkerLiveOneShot(job({ runId: "n5-room-marker-offline-010", responseSizeLimitBytes: 262144 }), { fetchImpl: tooLarge.fetchImpl }),
      (error) => error?.code === "V2_NAVER_ROOM_MARKER_RESPONSE_TOO_LARGE"
    );

    const wrongFinal = fixtureTransport(fixtureHtml, {
      url: "https://pcmap.place.naver.com/accommodation/999/home"
    });
    await rejects(
      () => runRoomProviderMarkerLiveOneShot(job({ runId: "n5-room-marker-offline-011" }), { fetchImpl: wrongFinal.fetchImpl }),
      (error) => error?.code === "V2_NAVER_ROOM_MARKER_RESPONSE_MISMATCH"
    );

    const timeoutCalls = [];
    await rejects(
      () => runRoomProviderMarkerLiveOneShot(job({ runId: "n5-room-marker-offline-012", timeoutMs: 100 }), {
        fetchImpl: async (_input, init) => {
          timeoutCalls.push(true);
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          });
        }
      }),
      (error) => error?.code === "V2_NAVER_ROOM_MARKER_TIMEOUT"
    );
    equal(timeoutCalls.length, 1);

    const liveJob = job({
      runId: "n5-room-marker-live-001",
      mode: "live",
      placeId: "35644668",
      fixtureScenario: "none"
    });
    const liveDigest = jobApprovalDigest(liveJob);
    throws(() => assertLiveApproval(liveJob, {}), (error) => error?.code === "V2_NAVER_ROOM_MARKER_LIVE_APPROVAL_REQUIRED");
    throws(() => assertLiveApproval(liveJob, {
      V2_NAVER_ROOM_MARKER_LIVE_APPROVED: "N5-Live",
      V2_NAVER_ROOM_MARKER_REQUEST_BUDGET: "1",
      V2_NAVER_ROOM_MARKER_APPROVED_JOB_SHA256: liveDigest
    }), (error) => error?.code === "V2_NAVER_ROOM_MARKER_LIVE_APPROVAL_REQUIRED");
    equal(assertLiveApproval(liveJob, {
      V2_NAVER_ROOM_MARKER_LIVE_APPROVED: LIVE_APPROVAL_NAME,
      V2_NAVER_ROOM_MARKER_REQUEST_BUDGET: "1",
      V2_NAVER_ROOM_MARKER_APPROVED_JOB_SHA256: liveDigest
    }), true);
    const simulatedLiveFixture = fixtureTransport(fixtureHtml);
    const simulatedLiveResult = await runRoomProviderMarkerLiveOneShot(liveJob, {
      environment: {
        V2_NAVER_ROOM_MARKER_LIVE_APPROVED: LIVE_APPROVAL_NAME,
        V2_NAVER_ROOM_MARKER_REQUEST_BUDGET: "1",
        V2_NAVER_ROOM_MARKER_APPROVED_JOB_SHA256: liveDigest
      },
      fetchImpl: simulatedLiveFixture.fetchImpl
    });
    equal(simulatedLiveFixture.calls.length, 1);
    equal(simulatedLiveResult.mode, "live");
    equal(simulatedLiveResult.audit.actualExternalRequests, 1);
    equal(simulatedLiveResult.audit.fixtureRequests, 0);
    equal(simulatedLiveResult.observation.evidence.captureKind, "sanitized_live_html_projection");
    equal(simulatedLiveResult.observation.audit.fixtureMode, false);
    let unapprovedFetchCalls = 0;
    await rejects(
      () => runRoomProviderMarkerLiveOneShot(liveJob, {
        environment: {},
        fetchImpl: async () => {
          unapprovedFetchCalls += 1;
          return new Response(fixtureHtml, { headers: { "content-type": "text/html" } });
        }
      }),
      (error) => error?.code === "V2_NAVER_ROOM_MARKER_LIVE_APPROVAL_REQUIRED"
    );
    equal(unapprovedFetchCalls, 0);

    const proposalFile = path.resolve(__dirname, "..", "docs", "v2_naver_place_room_provider_marker_live_job.proposal.json");
    equal(allowedJobPath(proposalFile, "live"), proposalFile);
    throws(
      () => allowedJobPath(proposalFile, "fixture"),
      (error) => error?.code === "V2_NAVER_ROOM_MARKER_FIXTURE_PATH_INVALID"
    );

    const outputText = JSON.stringify(result);
    equal(outputText.includes("<!doctype"), false);
    equal(outputText.includes("place_section_header"), false);
    equal(/cookie|authorization|bearer|api[_-]?key|access[_-]?token/iu.test(outputText), false);

    const runner = path.resolve(__dirname, "v2_naver_place_room_provider_marker_live_one_shot.cjs");
    const preload = path.resolve(__dirname, "fixture_network_guard_preload.cjs");
    const jobFile = path.resolve(__dirname, "..", "tests", "fixtures", "v2_naver_place_room_provider_marker_live_job.json");
    const child = spawnSync(process.execPath, ["--require", preload, runner, "fixture", jobFile, fixtureFile], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8"
    });
    equal(child.status, 0, child.stderr);
    equal(child.stderr, "");
    equal(child.stdout.trim().split(/\r?\n/u).length, 1);
    const childResult = JSON.parse(child.stdout);
    equal(childResult.placeId, "1460523479");
    equal(childResult.observation.roomCount, 6);
    equal(childResult.observation.providerMarker.standardChannelId, "campingtalk");
    equal(childResult.audit.actualExternalRequests, 0);
    equal(childResult.audit.operationalWrites, 0);

    const forbidden = spawnSync(process.execPath, [runner, "fixture", path.resolve(__dirname, "package.json"), fixtureFile], {
      encoding: "utf8"
    });
    equal(forbidden.status, 1);
    equal(forbidden.stdout, "");
    equal(JSON.parse(forbidden.stderr).code, "V2_NAVER_ROOM_MARKER_FIXTURE_PATH_INVALID");

    const unapprovedLive = spawnSync(process.execPath, ["--require", preload, runner, "live", proposalFile], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        V2_NAVER_ROOM_MARKER_LIVE_APPROVED: "",
        V2_NAVER_ROOM_MARKER_REQUEST_BUDGET: "",
        V2_NAVER_ROOM_MARKER_APPROVED_JOB_SHA256: ""
      }
    });
    equal(unapprovedLive.status, 1);
    equal(unapprovedLive.stdout, "");
    const unapprovedTerminal = JSON.parse(unapprovedLive.stderr);
    equal(unapprovedTerminal.schemaVersion, ERROR_SCHEMA_VERSION);
    equal(unapprovedTerminal.code, "V2_NAVER_ROOM_MARKER_LIVE_APPROVAL_REQUIRED");
    equal(Object.hasOwn(unapprovedTerminal, "diagnostic"), false);

    equal(guard.blockedAttempts(), 0);
    console.log(JSON.stringify({
      schemaVersion: "v2-naver-place-room-provider-marker-live-test.v2",
      status: "passed",
      assertions,
      requestEnvelope: {
        method: envelope.method,
        origin: envelope.origin,
        path: envelope.path
      },
      roomCount: result.observation.roomCount,
      standardChannelId: result.observation.providerMarker.standardChannelId,
      accessDiagnostics: ["http_403", "http_429", "challenge_html"],
      liveGateSimulation: "passed_without_provider_call",
      actualExternalRequests: 0,
      operationalWrites: 0
    }));
  } finally {
    guard.restore();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
