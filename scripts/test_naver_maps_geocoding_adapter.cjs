"use strict";

const assert = require("node:assert/strict");

let forbiddenGlobalFetchCalls = 0;
global.fetch = async () => {
  forbiddenGlobalFetchCalls += 1;
  throw new Error("global network access is forbidden in NAVER Maps adapter tests");
};

const { geocodeAddress } = require("./lodging_geocoding_contract.cjs");
const {
  CAPTURE_ARTIFACT_VERSION,
  MAX_ADDRESS_LENGTH,
  MAX_PROVIDER_REQUESTS,
  MAX_RESPONSE_BYTES,
  NAVER_MAPS_API_KEY_ENV,
  NAVER_MAPS_API_KEY_ID_ENV,
  NAVER_MAPS_GEOCODING_ENDPOINT,
  NAVER_MAPS_PROVIDER_KEY,
  RESULT_COUNT,
  createNaverMapsGeocodingAdapter,
  normalizeNaverAddress
} = require("./naver_maps_geocoding_adapter.cjs");

const TEST_KEY_ID = "fixture-key-id-not-a-secret";
const TEST_KEY = "fixture-key-not-a-secret";
const APPROVAL_TOKEN = "fixture-approved-capture-token-0001";
const FIXED_OBSERVED_AT = "2026-08-04T00:00:00.000Z";
const ADDRESS = "\uacbd\uc0c1\ub0a8\ub3c4 \ud569\ucc9c\uad70 \uac00\ud68c\uba74 \uac00\ud68c\uc0b0\ub85c 1";

function response(status, payload, options = {}) {
  const text = options.text ?? JSON.stringify(payload);
  const declaredLength = options.contentLength ?? Buffer.byteLength(text, "utf8");
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (options.omitContentLength === true) return null;
        return String(name).toLowerCase() === "content-length" ? String(declaredLength) : null;
      }
    },
    async text() {
      return text;
    }
  };
}

function okPayload(addresses = []) {
  return { status: "OK", meta: { totalCount: addresses.length, page: 1, count: addresses.length }, addresses, errorMessage: "" };
}

function naverRow(overrides = {}) {
  return {
    roadAddress: ADDRESS,
    jibunAddress: "\uacbd\uc0c1\ub0a8\ub3c4 \ud569\ucc9c\uad70 \uac00\ud68c\uba74 \uad6c\uc6d0\ub9ac 1",
    x: "128.165",
    y: "35.566",
    addressElements: [
      { types: ["SIDO"], longName: "\uacbd\uc0c1\ub0a8\ub3c4" },
      { types: ["SIGUGUN"], longName: "\ud569\ucc9c\uad70" },
      { types: ["ROAD_NAME"], longName: "\uac00\ud68c\uc0b0\ub85c" },
      { types: ["BUILDING_NUMBER"], longName: "1" }
    ],
    privateProviderPayload: "must-not-survive",
    ...overrides
  };
}

function configuredAdapter(request, overrides = {}) {
  const maxRequests = overrides.maxRequests ?? MAX_PROVIDER_REQUESTS;
  return createNaverMapsGeocodingAdapter({
    enabled: true,
    env: {
      [NAVER_MAPS_API_KEY_ID_ENV]: TEST_KEY_ID,
      [NAVER_MAPS_API_KEY_ENV]: TEST_KEY
    },
    request,
    maxRequests,
    approvalReceipt: {
      mode: "capture",
      providerKey: NAVER_MAPS_PROVIDER_KEY,
      maxRequests,
      token: APPROVAL_TOKEN
    },
    expectedApprovalToken: APPROVAL_TOKEN,
    now: () => FIXED_OBSERVED_AT,
    ...overrides
  });
}

async function assertRejectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.equal(String(error.message).includes(TEST_KEY_ID), false);
    assert.equal(String(error.message).includes(TEST_KEY), false);
    assert.equal(String(error.message).includes(APPROVAL_TOKEN), false);
    return true;
  });
}

async function main() {
  let calls = 0;
  const disabled = createNaverMapsGeocodingAdapter({
    enabled: true,
    env: {
      [NAVER_MAPS_API_KEY_ID_ENV]: TEST_KEY_ID,
      [NAVER_MAPS_API_KEY_ENV]: TEST_KEY
    },
    request: async () => {
      calls += 1;
      return response(200, okPayload());
    }
  });
  assert.equal(disabled.enabled, false, "credentials and enabled=true must not activate capture without an explicit limit and approval");
  assert.equal(disabled.configuration().maxRequests, 0, "the default provider request budget must be zero");
  await assertRejectCode(disabled({ normalizedAddress: ADDRESS, requestId: "company-disabled" }), "NAVER_GEOCODING_DISABLED");
  assert.equal(calls, 0);

  const noApproval = createNaverMapsGeocodingAdapter({
    enabled: true,
    apiKeyId: TEST_KEY_ID,
    apiKey: TEST_KEY,
    maxRequests: 1,
    request: async () => {
      calls += 1;
      return response(200, okPayload());
    }
  });
  assert.equal(noApproval.enabled, false, "a positive limit without a bound approval receipt must fail closed");
  await assertRejectCode(noApproval({ normalizedAddress: ADDRESS, requestId: "company-no-approval" }), "NAVER_GEOCODING_DISABLED");

  const wrongApproval = createNaverMapsGeocodingAdapter({
    enabled: true,
    apiKeyId: TEST_KEY_ID,
    apiKey: TEST_KEY,
    maxRequests: 2,
    approvalReceipt: {
      mode: "capture",
      providerKey: NAVER_MAPS_PROVIDER_KEY,
      maxRequests: 1,
      token: APPROVAL_TOKEN
    },
    expectedApprovalToken: APPROVAL_TOKEN,
    request: async () => {
      calls += 1;
      return response(200, okPayload());
    }
  });
  assert.equal(wrongApproval.enabled, false, "approval must cover the requested capture budget");
  await assertRejectCode(wrongApproval({ normalizedAddress: ADDRESS, requestId: "company-wrong-approval" }), "NAVER_GEOCODING_DISABLED");

  const mismatchedToken = createNaverMapsGeocodingAdapter({
    enabled: true,
    apiKeyId: TEST_KEY_ID,
    apiKey: TEST_KEY,
    maxRequests: 1,
    approvalReceipt: {
      mode: "capture",
      providerKey: NAVER_MAPS_PROVIDER_KEY,
      maxRequests: 1,
      token: APPROVAL_TOKEN
    },
    expectedApprovalToken: "different-approved-capture-token-0002",
    request: async () => {
      calls += 1;
      return response(200, okPayload());
    }
  });
  assert.equal(mismatchedToken.enabled, false, "an approval token mismatch must fail closed");
  await assertRejectCode(mismatchedToken({ normalizedAddress: ADDRESS, requestId: "company-token-mismatch" }), "NAVER_GEOCODING_DISABLED");

  const excessiveBudget = configuredAdapter(async () => {
    calls += 1;
    return response(200, okPayload());
  }, { maxRequests: MAX_PROVIDER_REQUESTS + 1 });
  assert.equal(excessiveBudget.enabled, false, "limits over 25 must fail closed rather than being silently clamped");
  assert.equal(excessiveBudget.configuration().maxRequests, 0);
  await assertRejectCode(excessiveBudget({ normalizedAddress: ADDRESS, requestId: "company-excessive-budget" }), "NAVER_GEOCODING_DISABLED");
  assert.equal(calls, 0);

  const missingSecret = createNaverMapsGeocodingAdapter({
    enabled: true,
    env: {},
    maxRequests: 1,
    approvalReceipt: { mode: "capture", providerKey: NAVER_MAPS_PROVIDER_KEY, maxRequests: 1, token: APPROVAL_TOKEN },
    expectedApprovalToken: APPROVAL_TOKEN,
    request: async () => {
      calls += 1;
      return response(200, okPayload());
    }
  });
  assert.equal(missingSecret.enabled, false, "missing credentials must fail closed");
  await assertRejectCode(missingSecret({ normalizedAddress: ADDRESS, requestId: "company-missing-secret" }), "NAVER_GEOCODING_DISABLED");
  assert.equal(calls, 0);

  assert.throws(
    () => configuredAdapter(async () => response(200, okPayload()), {
      endpoint: "https://example.invalid/geocode?key=must-not-appear"
    }),
    (error) => {
      assert.match(error.message, /not allowed/);
      assert.equal(error.message.includes("example.invalid"), false, "rejected endpoint values must not be reflected");
      return true;
    }
  );

  let capturedUrl = "";
  let capturedOptions = null;
  const successAdapter = configuredAdapter(async (url, options) => {
    calls += 1;
    capturedUrl = url;
    capturedOptions = options;
    return response(200, okPayload([naverRow()]));
  });
  const rawRows = await successAdapter({ normalizedAddress: ADDRESS, requestId: "company-success", signal: new AbortController().signal });
  assert.equal(rawRows.length, 1);
  assert.deepEqual(rawRows[0], {
    status: "approximate",
    latitude: 35.566,
    longitude: 128.165,
    crs: "EPSG:4326",
    precision: "street",
    source: "provider",
    providerKey: NAVER_MAPS_PROVIDER_KEY,
    confidence: null,
    resolvedAddress: ADDRESS,
    geocodedAt: FIXED_OBSERVED_AT
  });
  assert.equal(Object.isFrozen(rawRows), true);
  assert.equal("privateProviderPayload" in rawRows[0], false);

  const parcel = normalizeNaverAddress(naverRow({
    addressElements: [{ types: ["LAND_NUMBER"], longName: "1" }]
  }), { observedAt: FIXED_OBSERVED_AT });
  assert.equal(parcel.status, "resolved");
  assert.equal(parcel.precision, "parcel");
  assert.equal(parcel.latitude, 35.566);
  assert.equal(parcel.longitude, 128.165);

  const street = normalizeNaverAddress(naverRow(), { observedAt: FIXED_OBSERVED_AT });
  assert.equal(street.status, "approximate");
  assert.equal(street.precision, "street");
  assert.equal(street.latitude, 35.566);
  assert.equal(street.longitude, 128.165);

  for (const [precision, types] of [
    ["locality", ["DONGMYUN"]],
    ["region", ["SIDO", "SIGUGUN"]],
    ["unknown", ["BUILDING_NUMBER"]]
  ]) {
    const nonMappable = normalizeNaverAddress(naverRow({
      addressElements: [{ types, longName: "fixture" }]
    }), { observedAt: FIXED_OBSERVED_AT });
    assert.equal(nonMappable.status, "ambiguous", `${precision} provider evidence must require review`);
    assert.equal(nonMappable.precision, precision);
    assert.equal(nonMappable.latitude, null, `${precision} must not create a marker`);
    assert.equal(nonMappable.longitude, null, `${precision} must not create a marker`);
  }
  const requested = new URL(capturedUrl);
  assert.equal(requested.origin + requested.pathname, NAVER_MAPS_GEOCODING_ENDPOINT);
  assert.equal(requested.hostname, "maps.apigw.ntruss.com");
  assert.equal(requested.searchParams.get("query"), ADDRESS);
  assert.equal(requested.searchParams.get("language"), "kor");
  assert.equal(requested.searchParams.get("page"), "1");
  assert.equal(requested.searchParams.get("count"), String(RESULT_COUNT));
  assert.equal(capturedOptions.method, "GET");
  assert.equal(capturedOptions.redirect, "error", "redirects must not leave the allowlisted origin");
  assert.equal(capturedOptions.headers.Accept, "application/json");
  assert.equal(capturedOptions.headers["x-ncp-apigw-api-key-id"], TEST_KEY_ID);
  assert.equal(capturedOptions.headers["x-ncp-apigw-api-key"], TEST_KEY);
  assert.equal(capturedOptions.signal instanceof AbortSignal, true);
  const statusSnapshot = JSON.stringify(successAdapter.configuration());
  assert.equal(statusSnapshot.includes(TEST_KEY_ID), false);
  assert.equal(statusSnapshot.includes(TEST_KEY), false);
  assert.equal(statusSnapshot.includes(APPROVAL_TOKEN), false);
  assert.equal(successAdapter.configuration().captureApproved, true);
  assert.equal(successAdapter.configuration().retryCount, 0);
  assert.equal(successAdapter.configuration().usedRequests, 1);

  const captureAdapter = configuredAdapter(async () => response(200, okPayload([naverRow()])), { maxRequests: 1 });
  const captureArtifact = await captureAdapter.capture({ normalizedAddress: ADDRESS, requestId: "company-artifact" });
  assert.deepEqual(captureArtifact, {
    artifactVersion: CAPTURE_ARTIFACT_VERSION,
    providerKey: NAVER_MAPS_PROVIDER_KEY,
    requestId: "company-artifact",
    observedAt: FIXED_OBSERVED_AT,
    resultCount: 1,
    results: captureArtifact.results
  });
  assert.equal(Object.isFrozen(captureArtifact), true);
  assert.equal(Object.isFrozen(captureArtifact.results), true);
  assert.equal(JSON.stringify(captureArtifact).includes("privateProviderPayload"), false);
  assert.equal(JSON.stringify(captureArtifact).includes(TEST_KEY), false);
  assert.equal(JSON.stringify(captureArtifact).includes(ADDRESS), true, "only the sanitized resolved address may remain in the artifact");

  let pipelineCalls = 0;
  const pipelineAdapter = configuredAdapter(async () => {
    pipelineCalls += 1;
    return response(200, okPayload([naverRow()]));
  });
  const resolved = await geocodeAddress({ address: ADDRESS, requestId: "company-pipeline" }, {
    enabled: pipelineAdapter.enabled,
    adapter: pipelineAdapter,
    timeoutMs: 500
  });
  assert.equal(resolved.status, "approximate");
  assert.equal(resolved.providerKey, NAVER_MAPS_PROVIDER_KEY);
  assert.equal(resolved.latitude, 35.566);
  assert.equal(resolved.longitude, 128.165);
  assert.equal(resolved.geocodedAt, FIXED_OBSERVED_AT);
  assert.equal("privateProviderPayload" in resolved, false);
  assert.equal(pipelineCalls, 1);

  const localityAdapter = configuredAdapter(async () => response(200, okPayload([
    naverRow({ addressElements: [{ types: ["DONGMYUN"], longName: "가회면" }] })
  ])));
  const locality = await geocodeAddress({ address: ADDRESS, requestId: "company-locality" }, {
    enabled: localityAdapter.enabled,
    adapter: localityAdapter
  });
  assert.equal(locality.status, "ambiguous", "common contract must preserve provider ambiguity");
  assert.equal(locality.precision, "locality");
  assert.equal(locality.latitude, null);
  assert.equal(locality.longitude, null);

  const ambiguousCoordinate = await geocodeAddress({ address: ADDRESS, requestId: "company-ambiguous-coordinate" }, {
    enabled: true,
    adapter: async () => [{
      status: "ambiguous",
      latitude: 35.566,
      longitude: 128.165,
      precision: "locality",
      source: "provider"
    }]
  });
  assert.equal(ambiguousCoordinate.status, "ambiguous", "an explicit provider ambiguity must never be promoted to resolved");
  assert.equal(ambiguousCoordinate.latitude, null);
  assert.equal(ambiguousCoordinate.longitude, null);

  const ambiguousAdapter = configuredAdapter(async () => response(200, okPayload([
    naverRow(),
    naverRow({ roadAddress: `${ADDRESS} 2`, x: "128.166", y: "35.567" })
  ])));
  const ambiguous = await geocodeAddress({ address: ADDRESS, requestId: "company-ambiguous" }, {
    enabled: ambiguousAdapter.enabled,
    adapter: ambiguousAdapter
  });
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.latitude, null, "multiple provider matches must not create a marker");

  const emptyAdapter = configuredAdapter(async () => response(200, okPayload([])));
  const notFound = await geocodeAddress({ address: ADDRESS, requestId: "company-not-found" }, {
    enabled: emptyAdapter.enabled,
    adapter: emptyAdapter
  });
  assert.equal(notFound.status, "not_found");

  let limitedCalls = 0;
  const limitedAdapter = configuredAdapter(async () => {
    limitedCalls += 1;
    return response(429, { status: "ERROR", rawSecret: TEST_KEY });
  });
  const rateLimited = await geocodeAddress({ address: ADDRESS, requestId: "company-rate-limited" }, {
    enabled: limitedAdapter.enabled,
    adapter: limitedAdapter
  });
  assert.equal(rateLimited.status, "error");
  assert.equal(rateLimited.errorCode, "rate_limited");
  assert.equal(limitedCalls, 1, "the adapter must not retry a 429 response");

  let unavailableCalls = 0;
  const unavailableAdapter = configuredAdapter(async () => {
    unavailableCalls += 1;
    return response(503, { errorMessage: `do not leak ${TEST_KEY}` });
  });
  const unavailable = await geocodeAddress({ address: ADDRESS, requestId: "company-unavailable" }, {
    enabled: unavailableAdapter.enabled,
    adapter: unavailableAdapter
  });
  assert.equal(unavailable.status, "error");
  assert.equal(unavailable.errorCode, "provider_unavailable");
  assert.equal(unavailableCalls, 1, "the adapter must not retry a 5xx response");
  assert.equal(JSON.stringify(unavailable).includes(TEST_KEY), false);

  let timeoutCalls = 0;
  const timeoutAdapter = configuredAdapter(async (_url, { signal }) => {
    timeoutCalls += 1;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const timedOut = await geocodeAddress({ address: ADDRESS, requestId: "company-timeout" }, {
    enabled: timeoutAdapter.enabled,
    adapter: timeoutAdapter,
    timeoutMs: 100
  });
  assert.equal(timedOut.status, "error");
  assert.equal(timedOut.errorCode, "timeout");
  assert.equal(timeoutCalls, 1, "timeouts must not be retried");

  const oversizedLengthAdapter = configuredAdapter(async () => response(200, okPayload([]), {
    contentLength: MAX_RESPONSE_BYTES + 1
  }));
  await assertRejectCode(
    oversizedLengthAdapter({ normalizedAddress: ADDRESS, requestId: "company-oversized-length" }),
    "NAVER_GEOCODING_RESPONSE_TOO_LARGE"
  );

  const oversizedBodyAdapter = configuredAdapter(async () => response(200, null, {
    text: "x".repeat(MAX_RESPONSE_BYTES + 1),
    omitContentLength: true
  }));
  await assertRejectCode(
    oversizedBodyAdapter({ normalizedAddress: ADDRESS, requestId: "company-oversized-body" }),
    "NAVER_GEOCODING_RESPONSE_TOO_LARGE"
  );

  const excessiveRowsAdapter = configuredAdapter(async () => response(200, okPayload([
    naverRow(), naverRow(), naverRow(), naverRow()
  ])));
  await assertRejectCode(
    excessiveRowsAdapter({ normalizedAddress: ADDRESS, requestId: "company-excessive-rows" }),
    "NAVER_GEOCODING_INVALID_RESPONSE"
  );

  const longAddress = "\uac00".repeat(MAX_ADDRESS_LENGTH + 50);
  const boundedAddressAdapter = configuredAdapter(async () => response(200, okPayload([
    naverRow({ roadAddress: longAddress })
  ])));
  const boundedRows = await boundedAddressAdapter({ normalizedAddress: ADDRESS, requestId: "company-bounded-address" });
  assert.equal(boundedRows[0].resolvedAddress.length, MAX_ADDRESS_LENGTH);

  let onePerCompanyCalls = 0;
  const onePerCompany = configuredAdapter(async () => {
    onePerCompanyCalls += 1;
    return response(200, okPayload([]));
  });
  await onePerCompany({ normalizedAddress: ADDRESS, requestId: "company-once" });
  await assertRejectCode(
    onePerCompany({ normalizedAddress: ADDRESS, requestId: "company-once" }),
    "NAVER_GEOCODING_DUPLICATE_REQUEST"
  );
  assert.equal(onePerCompanyCalls, 1);
  await assertRejectCode(
    onePerCompany({ normalizedAddress: ADDRESS, requestId: "" }),
    "NAVER_GEOCODING_REQUEST_ID_REQUIRED"
  );
  assert.equal(onePerCompanyCalls, 1);

  let budgetCalls = 0;
  const budgetAdapter = configuredAdapter(async () => {
    budgetCalls += 1;
    return response(200, okPayload([]));
  }, { maxRequests: MAX_PROVIDER_REQUESTS });
  assert.equal(budgetAdapter.configuration().maxRequests, MAX_PROVIDER_REQUESTS);
  for (let index = 0; index < MAX_PROVIDER_REQUESTS; index += 1) {
    await budgetAdapter({ normalizedAddress: ADDRESS, requestId: `company-budget-${index}` });
  }
  await assertRejectCode(
    budgetAdapter({ normalizedAddress: ADDRESS, requestId: "company-over-budget" }),
    "NAVER_GEOCODING_BUDGET_EXHAUSTED"
  );
  assert.equal(budgetCalls, MAX_PROVIDER_REQUESTS);
  assert.equal(budgetAdapter.configuration().remainingRequests, 0);

  const invalidCoordinate = normalizeNaverAddress(naverRow({ x: "not-a-number", y: "35.566" }), {
    observedAt: FIXED_OBSERVED_AT
  });
  assert.equal(invalidCoordinate.status, "invalid");
  assert.equal(invalidCoordinate.longitude, null);
  assert.equal(invalidCoordinate.latitude, null);
  assert.equal("privateProviderPayload" in invalidCoordinate, false);

  assert.equal(forbiddenGlobalFetchCalls, 0, "the adapter must never fall back to global fetch");
  console.log("NAVER Maps Geocoding adapter approval, bounded capture, budget, normalization, and no-network tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
