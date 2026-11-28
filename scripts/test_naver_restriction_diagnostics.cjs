"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createNaverRequestGate } = require("./naver_request_pacing.cjs");
const { describeNaverRequest, parseRetryAfterSeconds, sanitizeRestrictionDetails, MAX_RETRY_AFTER_SECONDS } = require("./lib/naver_restriction_diagnostics.cjs");

const publicRequest = (operationName, id, extra = {}) => ({
  method: "POST", headers: { authorization: "Bearer PRIVATE_AUTH", cookie: "PRIVATE_COOKIE" },
  body: JSON.stringify({ operationName, query: "PRIVATE_GRAPHQL_TEXT", variables: { id, secret: "PRIVATE_VARIABLE", ...extra } }),
});
const blockedError = () => Object.assign(new Error("PRIVATE_PROVIDER_MESSAGE https://private.example/?token=PRIVATE_TOKEN"), {
  code: "NAVER_REQUEST_BLOCKED", statusCode: 429,
});
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

test("request diagnostics keep only exact endpoint classes, known operations and public place IDs", () => {
  const value = describeNaverRequest("https://pcmap-api.place.naver.com/graphql?token=PRIVATE_QUERY#PRIVATE_FRAGMENT",
    publicRequest("naverPlaceChannelObservation", "1234567890"));
  assert.deepEqual(value, { endpointCategory: "place_graphql", operationName: "naverPlaceChannelObservation", targetCompanyId: "cmp_place_1234567890" });
  assert.deepEqual(describeNaverRequest("https://pcmap-api.place.naver.com/graphql", publicRequest("naverBookingBusiness", "123")),
    { endpointCategory: "place_graphql", operationName: "naverBookingBusiness", targetCompanyId: "cmp_place_123" });
  assert.deepEqual(describeNaverRequest("https://pcmap.place.naver.com/accommodation/list?query=PRIVATE_QUERY"), { endpointCategory: "place_search" });
  assert.deepEqual(describeNaverRequest("https://m.place.naver.com/accommodation/123/room?token=PRIVATE_QUERY"),
    { endpointCategory: "place_document", targetCompanyId: "cmp_place_123" });
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|https?:|authorization|cookie|query|variables|body/i);
});

test("booking business identifiers are never mislabelled as company identifiers", () => {
  for (const operation of ["searchBizItem", "dailySchedule"]) {
    assert.deepEqual(describeNaverRequest("https://m.booking.naver.com/graphql", publicRequest(operation, "123", { businessId: "456" })),
      { endpointCategory: "booking_graphql", operationName: operation });
  }
  assert.deepEqual(describeNaverRequest("https://m.booking.naver.com/graphql", publicRequest("naverBookingBusiness", "123")),
    { endpointCategory: "booking_graphql" });
});

test("untrusted inputs, unknown operations and oversized bodies do not become diagnostic text", () => {
  for (const input of ["invalid", "https://pcmap-api.place.naver.com.evil.example/graphql", "https://PRIVATE_USER:PRIVATE_PASSWORD@pcmap-api.place.naver.com/graphql", "https://pcmap-api.place.naver.com/private/PRIVATE_PATH", "https://pcmap.place.naver.com/accommodation/PRIVATE_ID/room", "file://pcmap-api.place.naver.com/graphql"]) {
    assert.deepEqual(describeNaverRequest(input, publicRequest("naverBookingBusiness", "123")), {});
  }
  for (const operation of ["PRIVATE_OPERATION", "naverBookingBusiness PRIVATE_TOKEN", null, {}]) {
    assert.deepEqual(describeNaverRequest("https://pcmap-api.place.naver.com/graphql", publicRequest(operation, "123")), { endpointCategory: "place_graphql" });
  }
  for (const id of ["0123", "PRIVATE_ID", "1".repeat(31), 123, null]) {
    assert.deepEqual(describeNaverRequest("https://pcmap-api.place.naver.com/graphql", publicRequest("naverBookingBusiness", id)),
      { endpointCategory: "place_graphql", operationName: "naverBookingBusiness" });
  }
  for (const body of ["not json", "PRIVATE_BODY".repeat(10000), JSON.stringify({ operationName: "naverBookingBusiness", variables: { id: "123" }, pad: "가".repeat(23000) })]) {
    assert.deepEqual(describeNaverRequest("https://pcmap-api.place.naver.com/graphql", { body }), { endpointCategory: "place_graphql" });
  }
});

test("URL and Request inputs are classified without consuming streams or invoking init accessors", () => {
  assert.deepEqual(describeNaverRequest(new URL("https://pcmap.place.naver.com/accommodation/123/home?token=PRIVATE_TOKEN")),
    { endpointCategory: "place_document", targetCompanyId: "cmp_place_123" });
  const request = new Request("https://pcmap-api.place.naver.com/graphql?token=PRIVATE_TOKEN", {
    method: "POST", body: JSON.stringify({ operationName: "naverBookingBusiness", variables: { id: "123" } }),
  });
  assert.deepEqual(describeNaverRequest(request), { endpointCategory: "place_graphql" });
  assert.equal(request.bodyUsed, false);
  let bodyReads = 0, urlReads = 0;
  const init = Object.defineProperty({}, "body", { get() { bodyReads++; throw Error("PRIVATE_GETTER"); } });
  const input = Object.defineProperty({}, "url", { get() { urlReads++; throw Error("PRIVATE_GETTER"); } });
  assert.deepEqual(describeNaverRequest("https://pcmap-api.place.naver.com/graphql", init), { endpointCategory: "place_graphql" });
  assert.deepEqual(describeNaverRequest(input), {});
  assert.equal(bodyReads, 0); assert.equal(urlReads, 0);
});

test("Retry-After accepts bounded delta seconds and strict UTC dates, without returning the raw header", () => {
  const at = Date.parse("2026-11-28T00:00:00.250Z");
  assert.equal(parseRetryAfterSeconds("120"), 120);
  assert.equal(parseRetryAfterSeconds("00120"), 120);
  assert.equal(parseRetryAfterSeconds(" 0 "), 0);
  assert.equal(parseRetryAfterSeconds(String(MAX_RETRY_AFTER_SECONDS)), MAX_RETRY_AFTER_SECONDS);
  assert.equal(parseRetryAfterSeconds("Sat, 28 Nov 2026 00:02:00 GMT", at), 120);
  assert.equal(parseRetryAfterSeconds("Sat, 28 Nov 2026 00:02:00 GMT", () => at), 120);
  for (const value of [null, undefined, 120, {}, "", "+120", "-1", "1.5", "120 PRIVATE_TOKEN", "PRIVATE_HEADER".repeat(10), String(MAX_RETRY_AFTER_SECONDS + 1), "2026-11-28T00:02:00Z", "Fri, 28 Nov 2026 00:02:00 GMT", "Sat, 31 Nov 2026 00:02:00 GMT", "Sat, 28 Nov 2026 00:00:00 GMT"]) {
    assert.equal(parseRetryAfterSeconds(value, at), null, String(value));
  }
  assert.equal(parseRetryAfterSeconds("Sat, 28 Nov 2026 00:02:00 GMT", () => { throw Error("PRIVATE_CLOCK"); }), null);
  assert.equal(parseRetryAfterSeconds("Sat, 28 Nov 2026 00:02:00 GMT", NaN), null);
  assert.equal(parseRetryAfterSeconds("60", () => { throw Error("should not read the clock for a delta"); }), 60);
});

test("public stop metadata is sanitized into bounded flat optional fields", () => {
  assert.deepEqual(sanitizeRestrictionDetails({ endpointCategory: "place_graphql", operationName: "naverBookingBusiness", targetCompanyId: "cmp_place_123", retryAfterSeconds: 60,
    url: "PRIVATE_URL", body: "PRIVATE_BODY", headers: { secret: "PRIVATE_HEADER" }, providerCode: "PRIVATE_CODE" }),
  { endpointCategory: "place_graphql", operationName: "naverBookingBusiness", targetCompanyId: "cmp_place_123", retryAfterSeconds: 60 });
  assert.deepEqual(sanitizeRestrictionDetails({ endpointCategory: "booking_graphql", operationName: "dailySchedule", targetCompanyId: "cmp_place_123", retryAfterSeconds: Infinity }),
    { endpointCategory: "booking_graphql", operationName: "dailySchedule" });
  assert.deepEqual(sanitizeRestrictionDetails({ endpointCategory: "PRIVATE_CATEGORY", operationName: "PRIVATE_OPERATION", targetCompanyId: "PRIVATE_ID", retryAfterSeconds: -1 }), {});
});

test("concurrent 429 responses retain their own public target and Retry-After while preserving guard counters", async () => {
  const pending = [deferred(), deferred()], calls = [], originals = [];
  const reasons = [blockedError(), blockedError()];
  let monotonic = 0;
  const wall = Date.parse("2026-11-28T00:00:00Z");
  const gate = createNaverRequestGate({ enabled: true, pacingEnabled: false, now: () => monotonic, wallNow: () => wall,
    sleep: () => { throw Error("diagnostics must not introduce pacing"); },
    fetchImpl: (input, init) => { calls.push([input, init]); monotonic++; return pending[calls.length - 1].promise; },
    onResponse: (response, { stop, requestMetadata }) => {
      assert.ok(Object.isFrozen(requestMetadata));
      stop(reasons[requestMetadata.targetCompanyId === "cmp_place_111" ? 0 : 1], {
        code: "NAVER_REQUEST_BLOCKED", httpStatus: response.status,
        // Call-site fields must not replace the per-request descriptor.
        targetCompanyId: "cmp_place_999", endpointCategory: "PRIVATE_OVERRIDE", body: "PRIVATE_CALLBACK_BODY",
      });
    },
  });
  const inits = [publicRequest("naverPlaceChannelObservation", "111"), publicRequest("naverBookingBusiness", "222")];
  const input = "https://pcmap-api.place.naver.com/graphql?token=PRIVATE_QUERY";
  const requests = inits.map(init => gate.fetch(input, init));
  originals[1] = new Response("PRIVATE_PROVIDER_BODY_222", { status: 429, headers: { "retry-after": "120", "x-private": "PRIVATE_HEADER" } });
  pending[1].resolve(originals[1]);
  assert.strictEqual(await requests[1], originals[1]);
  originals[0] = new Response("PRIVATE_PROVIDER_BODY_111", { status: 429, headers: { "retry-after": "Sat, 28 Nov 2026 00:01:00 GMT" } });
  pending[0].resolve(originals[0]);
  assert.strictEqual(await requests[0], originals[0]);
  await assert.rejects(gate.fetch(input, inits[0]), error => error === reasons[1]);
  for (let i=0; i<2; i++) {
    assert.strictEqual(calls[i][1], inits[i]);
    assert.equal(originals[i].bodyUsed, false);
    assert.equal(await originals[i].text(), `PRIVATE_PROVIDER_BODY_${i === 0 ? "111" : "222"}`);
    assert.deepEqual(Object.keys(inits[i]).sort(), ["body", "headers", "method"]);
  }
  const d = gate.diagnostics(), t = d.requestTimeline;
  assert.equal(calls.length, 2); assert.equal(d.requestCount, 2); assert.equal(d.failedRequests, 0); assert.equal(d.cancelledBeforeStart, 1);
  assert.equal(d.maxInFlight, 2); assert.equal(d.minObservedStartIntervalMs, 1); assert.equal(d.totalWaitMs, 0);
  assert.equal(d.stopped, true); assert.equal(t.schemaVersion, 1); assert.equal(t.complete, true); assert.equal(t.snapshotInFlight, 0); assert.equal(t.snapshotQueued, 0);
  assert.deepEqual(t.restrictionEvents.map(({ detectedAt, ...rest }) => rest), [
    { code: "NAVER_REQUEST_BLOCKED", httpStatus: 429, endpointCategory: "place_graphql", operationName: "naverBookingBusiness", targetCompanyId: "cmp_place_222", retryAfterSeconds: 120 },
    { code: "NAVER_REQUEST_BLOCKED", httpStatus: 429, endpointCategory: "place_graphql", operationName: "naverPlaceChannelObservation", targetCompanyId: "cmp_place_111", retryAfterSeconds: 60 },
  ]);
  assert.doesNotMatch(JSON.stringify(t), /PRIVATE_|Bearer|authorization|cookie|https?:|"body"|"headers"|"query"|"variables"/i);
  t.restrictionEvents[0].targetCompanyId = "cmp_place_999";
  assert.equal(gate.diagnostics().requestTimeline.restrictionEvents[0].targetCompanyId, "cmp_place_222");
});

test("legacy direct stops keep the original three-field shape and bound remains sixteen", () => {
  const at = Date.parse("2026-11-28T00:00:00Z");
  const gate = createNaverRequestGate({ wallNow: () => at, fetchImpl: () => { throw Error("must not fetch"); } });
  const reason = blockedError();
  gate.stop(reason, { code: "NAVER_REQUEST_BLOCKED", httpStatus: 429, body: "PRIVATE_BODY" });
  assert.deepEqual(gate.diagnostics().requestTimeline.restrictionEvents, [{ detectedAt: "2026-11-28T00:00:00.000Z", code: "NAVER_REQUEST_BLOCKED", httpStatus: 429 }]);
  for (let i=0; i<17; i++) gate.stop(reason, { code: "NAVER_REQUEST_BLOCKED", httpStatus: 429, endpointCategory: "place_document", targetCompanyId: `cmp_place_${i+1}` });
  const timeline = gate.diagnostics().requestTimeline;
  assert.equal(timeline.maxRestrictionEvents, 16); assert.equal(timeline.restrictionEvents.length, 16);
  assert.equal(timeline.restrictionEventsTruncated, true); assert.equal(timeline.complete, false);
});

test("a broken optional Retry-After header cannot prevent a stop or turn a completed response into a request failure", async () => {
  const reason = blockedError();
  const response = { status: 429, body: null, headers: { get() { throw Error("PRIVATE_BAD_HEADER"); } } };
  const gate = createNaverRequestGate({ pacingEnabled: false, fetchImpl: async () => response,
    onResponse: (r, { stop }) => stop(reason, { code: "NAVER_REQUEST_BLOCKED", httpStatus: r.status }),
  });
  assert.strictEqual(await gate.fetch("https://pcmap-api.place.naver.com/graphql", publicRequest("naverBookingBusiness", "123")), response);
  await assert.rejects(gate.fetch("https://pcmap-api.place.naver.com/graphql"), error => error === reason);
  const d=gate.diagnostics();
  assert.equal(d.failedRequests,0); assert.equal(d.cancelledBeforeStart,1); assert.equal(d.stopped,true);
  assert.equal(d.requestTimeline.restrictionEvents[0].httpStatus,429);
  assert.doesNotMatch(JSON.stringify(d),/PRIVATE_|raw|headers|body/);
});
