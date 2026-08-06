"use strict";

const assert = require("node:assert/strict");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  FIXED_LEGACY_HEADERS,
  NAVER_PLACE_LIST_ORIGIN,
  NAVER_PLACE_LIST_PATH,
  createNaverLegacyCanaryLiveTransport
} = require("./naver_legacy_canary_live_transport.cjs");

const guard = installFixtureNetworkGuard({ label: "naver legacy canary live transport fixtures" });
const SENTINEL_QUERY = "Synthetic sentinel lodging";

function request() {
  return Object.freeze({
    providerId: "naver_place_search",
    providerOperation: "naver_place_accommodation_search_snapshot",
    query: SENTINEL_QUERY,
    searchMode: "keyword",
    rankStart: 1,
    rankEnd: 50,
    display: 50,
    requestOrdinal: 1,
    callBudget: 1,
    actualCallsEnabled: true,
    fixtureOnly: false
  });
}

function response(body = "fixture body", options = {}) {
  return {
    status: options.status ?? 200,
    headers: new Headers(options.headers || {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": "sentinel-cookie=forbidden",
      "x-private": "sentinel-private-header"
    }),
    text: async () => body
  };
}

(async () => {
  assert.throws(
    () => createNaverLegacyCanaryLiveTransport({ enabled: false, fetchImpl: async () => response() }),
    (error) => error?.code === "NAVER_LEGACY_CANARY_TRANSPORT_DISABLED"
  );

  let capturedUrl = null;
  let capturedOptions = null;
  const transport = createNaverLegacyCanaryLiveTransport({
    enabled: true,
    allowTextFallback: true,
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return response();
    }
  });
  const result = await transport(request());
  assert.equal(transport.callCount(), 1);
  assert.equal(transport.maxCalls, 1);
  assert.equal(result.status, 200);
  assert.equal(result.body, "fixture body");
  assert.deepEqual(result.headers, { "content-type": "text/html; charset=utf-8" });
  assert.equal(capturedUrl.origin, NAVER_PLACE_LIST_ORIGIN);
  assert.equal(capturedUrl.pathname, NAVER_PLACE_LIST_PATH);
  assert.equal(capturedUrl.searchParams.get("query"), SENTINEL_QUERY);
  assert.equal(capturedOptions.method, "GET");
  assert.equal(capturedOptions.redirect, "manual");
  assert.deepEqual(capturedOptions.headers, FIXED_LEGACY_HEADERS);
  assert.equal(Object.keys(capturedOptions.headers).some((key) => /cookie|authorization/i.test(key)), false);

  await assert.rejects(
    () => transport(request()),
    (error) => error?.code === "NAVER_LEGACY_CANARY_CALL_BUDGET_EXCEEDED"
  );
  assert.equal(transport.callCount(), 1);

  const oversized = createNaverLegacyCanaryLiveTransport({
    enabled: true,
    allowTextFallback: true,
    maxResponseBytes: 8,
    fetchImpl: async () => response("123456789")
  });
  await assert.rejects(
    () => oversized(request()),
    (error) => error?.code === "NAVER_LEGACY_CANARY_RESPONSE_TOO_LARGE"
  );
  assert.equal(oversized.callCount(), 1);

  const unsafeFailure = createNaverLegacyCanaryLiveTransport({
    enabled: true,
    allowTextFallback: true,
    fetchImpl: async () => {
      throw new Error(`unsafe ${SENTINEL_QUERY} https://sentinel.invalid/?forbidden=fixture-marker`);
    }
  });
  await assert.rejects(
    () => unsafeFailure(request()),
    (error) => {
      assert.equal(error?.code, "NAVER_LEGACY_CANARY_TRANSPORT_FAILED");
      assert.equal(String(error?.message || "").includes(SENTINEL_QUERY), false);
      assert.equal(String(error?.message || "").includes("sentinel.invalid"), false);
      return true;
    }
  );

  let cancelled = 0;
  const blocked = createNaverLegacyCanaryLiveTransport({
    enabled: true,
    fetchImpl: async () => ({
      status: 429,
      headers: new Headers({ "retry-after": "60", "content-length": "9999999" }),
      body: { cancel: async () => { cancelled += 1; } }
    })
  });
  const blockedResponse = await blocked(request());
  assert.equal(blockedResponse.status, 429);
  assert.equal(blockedResponse.body, "");
  assert.equal(blockedResponse.headers["retry-after"], "60");
  assert.equal(cancelled, 1);

  assert.equal(guard.blockedAttempts(), 0);
  guard.restore();
  console.log("NAVER legacy canary live transport fixtures passed");
})().catch((error) => {
  guard.restore();
  console.error(error);
  process.exitCode = 1;
});
