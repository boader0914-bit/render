"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  LIVE_PROVIDER_ID,
  NAVER_API_HUB_LOCAL_ENDPOINT,
  NAVER_API_HUB_LOCAL_HOST,
  NAVER_SEARCH_MODES,
  PROVIDER_KEYS,
  approvalManifestDigest,
  boundedBackoffMs,
  createV2LiveCollectionProvider,
  normalizeBookingProducts,
  parseNaverApiHubLocalPayload,
  parseNaverSearchPayload,
  parseRetryAfterMs,
  stableRequestKey
} = require("./integration/services/v2_live_collection_provider.cjs");

const FIXED_NOW = Date.parse("2026-07-30T01:02:03.000Z");
const FIXTURE_HOST = "fixture.example.invalid";

function approvalManifest(requestBudget = { perRun: 20, perDay: 100 }) {
  return {
    version: "v2-live-approval-v1",
    approvalId: "approval-test-live-provider-001",
    issuedAt: "2026-07-29T00:00:00.000Z",
    expiresAt: "2026-08-30T00:00:00.000Z",
    targets: [
      { targetName: "실제 숙소", regionCode: "", targetDates: ["2026-08-01"] },
      { targetName: "실제 숙소", regionCode: "경남 거창군", targetDates: ["2026-08-01"] }
    ],
    providers: Object.values(PROVIDER_KEYS),
    stages: ["discovery", "quick", "detail", "ota"],
    requestCaps: { ...requestBudget },
    providerCaps: {
      [PROVIDER_KEYS.naverSearch]: { perRun: requestBudget.perRun, perDay: requestBudget.perDay, costMicros: 0, stages: ["discovery", "quick", "detail"] },
      [PROVIDER_KEYS.naverBooking]: { perRun: requestBudget.perRun, perDay: requestBudget.perDay, costMicros: 0, stages: ["detail"] },
      [PROVIDER_KEYS.nol]: { perRun: requestBudget.perRun, perDay: requestBudget.perDay, costMicros: 0, stages: ["ota"] },
      [PROVIDER_KEYS.ddnayo]: { perRun: requestBudget.perRun, perDay: requestBudget.perDay, costMicros: 0, stages: ["ota"] }
    },
    cost: { currency: "KRW", maximumCostMicros: 0 }
  };
}

function quotaRepository() {
  const rows = [];
  return {
    rows,
    async reserveProviderRequest(payload) {
      const runRows = rows.filter((row) => row.runId === payload.runId);
      const dayRows = rows.filter((row) => row.day === payload.day);
      const providerRunRows = runRows.filter((row) => row.provider === payload.provider);
      const providerDayRows = dayRows.filter((row) => row.provider === payload.provider);
      if (runRows.length >= payload.caps.perRun || dayRows.length >= payload.caps.perDay
        || providerRunRows.length >= payload.caps.providerPerRun
        || providerDayRows.length >= payload.caps.providerPerDay) {
        const error = new Error("quota exceeded");
        error.code = "FRESH_PROVIDER_QUOTA_EXCEEDED";
        error.statusCode = 429;
        throw error;
      }
      rows.push({ ...payload });
      return { reservation: payload, idempotent: false };
    }
  };
}

function searchHtml(query = "실제 숙소", companyName = "실제 숙소") {
  const searchKey = `accommodationSearch(${JSON.stringify({ input: { query, display: 50 } })})`;
  const state = {
    ROOT_QUERY: {
      [searchKey]: {
        business: {
          total: 1,
          items: [{ __ref: "Accommodation:place-100" }]
        }
      }
    },
    "Accommodation:place-100": {
      id: "place-100",
      name: companyName,
      category: "글램핑",
      commonAddress: "경남 거창군 테스트로 1",
      totalReviewCount: 321,
      placeReviewScore: 4.8,
      hasBooking: true,
      bookingBusinessId: "booking-100",
      x: "127.1234",
      y: "35.5678",
      roomImages: [{ __ref: "Room:1" }]
    },
    "Room:1": {
      name: "기본 객실",
      minPrice: 150000,
      maxPrice: 180000
    }
  };
  return `<html><script>window.__APOLLO_STATE__ = ${JSON.stringify(state)};</script></html>`;
}

function endpointBuilders() {
  return {
    search({ query }) {
      return `https://${FIXTURE_HOST}/naver/search?query=${encodeURIComponent(query)}`;
    },
    bookingBusiness() {
      return `https://${FIXTURE_HOST}/naver/booking-business`;
    },
    bookingItems() {
      return `https://${FIXTURE_HOST}/naver/booking-items`;
    },
    bookingSchedule({ itemId }) {
      return `https://${FIXTURE_HOST}/naver/booking-schedule/${encodeURIComponent(itemId)}`;
    },
    nol() {
      return `https://${FIXTURE_HOST}/ota/nol`;
    },
    ddnayo({ query }) {
      return `https://${FIXTURE_HOST}/ota/ddnayo?query=${encodeURIComponent(query)}`;
    }
  };
}

function apiHubLocalPayload(overrides = {}) {
  return {
    lastBuildDate: "Wed, 30 Jul 2026 01:02:03 +0900",
    total: 1,
    start: 1,
    display: 1,
    items: [{
      title: "<b>Official</b> Stay &amp; Spa",
      link: "https://example.invalid/official-stay",
      category: "Lodging>Pension",
      description: "",
      telephone: "",
      address: "Seoul Jung-gu Test-dong 1",
      roadAddress: "Seoul Jung-gu Test-ro 1",
      mapx: "311277",
      mapy: "552097",
      ...overrides
    }]
  };
}

function officialApprovalManifest(requestBudget = { perRun: 5, perDay: 10 }) {
  const manifest = approvalManifest(requestBudget);
  manifest.targets.push({
    targetName: "Official Stay & Spa",
    regionCode: "seoul",
    targetDates: ["2026-08-01"]
  });
  manifest.providers = [PROVIDER_KEYS.naverSearch];
  manifest.stages = ["discovery", "quick"];
  manifest.providerCaps = {
    [PROVIDER_KEYS.naverSearch]: {
      perRun: requestBudget.perRun,
      perDay: requestBudget.perDay,
      costMicros: 0,
      stages: ["discovery", "quick"]
    }
  };
  return manifest;
}

function defaultFakeResponse(request) {
  if (request.operation === "naver-search") {
    const query = new URL(request.url).searchParams.get("query") || "실제 숙소";
    return { status: 200, url: request.url, headers: {}, body: searchHtml(query, "실제 숙소") };
  }
  if (request.operation === "naver-booking-business") {
    return {
      status: 200,
      url: request.url,
      headers: {},
      body: { data: { business: { naverBooking: { bookingBusinessId: "booking-100" } } } }
    };
  }
  if (request.operation === "naver-booking-items") {
    return {
      status: 200,
      url: request.url,
      headers: {},
      body: {
        data: {
          searchBizItem: {
            bizItems: [{
              id: "item-100",
              bizItemId: "item-100",
              businessId: "booking-100",
              name: "기본 객실",
              price: 150000
            }]
          }
        }
      }
    };
  }
  if (request.operation === "naver-booking-schedule") {
    return {
      status: 200,
      url: request.url,
      headers: {},
      body: {
        data: {
          schedule: {
            bizItemSchedule: {
              daily: {
                date: {
                  "2026-08-01": {
                    stock: 5,
                    bookingCount: 2,
                    occupiedBookingCount: 0,
                    price: 150000,
                    isBusinessDay: true,
                    isSaleDay: true
                  }
                }
              }
            }
          }
        }
      }
    };
  }
  if (request.operation === "nol-search") {
    return {
      status: 200,
      url: request.url,
      headers: {},
      body: {
        items: [{
          type: "PRODUCT_ITEM",
          data: { id: "nol-100", title: "실제 숙소", action: { web: "https://nol.example.invalid/product/100" } }
        }]
      }
    };
  }
  if (request.operation === "ddnayo-search") {
    return {
      status: 200,
      url: request.url,
      headers: {},
      body: {
        data: {
          totalSize: 1,
          contents: [{ accommodationId: "dd-100", accommodationName: "실제 숙소" }]
        }
      }
    };
  }
  throw new Error(`Unexpected fake operation: ${request.operation}`);
}

function createHarness(overrides = {}) {
  const calls = [];
  const sleeps = [];
  const fakeTransport = overrides.transport || (async (request) => {
    calls.push({ ...request, signal: undefined });
    return defaultFakeResponse(request);
  });
  if (!Object.prototype.hasOwnProperty.call(fakeTransport, "transportKind")) {
    Object.defineProperty(fakeTransport, "transportKind", { value: "fake" });
  }
  const allAllowed = {
    [PROVIDER_KEYS.naverSearch]: [FIXTURE_HOST],
    [PROVIDER_KEYS.naverBooking]: [FIXTURE_HOST],
    [PROVIDER_KEYS.nol]: [FIXTURE_HOST],
    [PROVIDER_KEYS.ddnayo]: [FIXTURE_HOST]
  };
  const allRunning = {
    [PROVIDER_KEYS.naverSearch]: false,
    [PROVIDER_KEYS.naverBooking]: false,
    [PROVIDER_KEYS.nol]: false,
    [PROVIDER_KEYS.ddnayo]: false
  };
  const requestBudget = overrides.requestBudget || { perRun: 20, perDay: 100 };
  const manifest = overrides.approvalManifest || approvalManifest(requestBudget);
  const durableQuota = overrides.quotaRepository || quotaRepository();
  const provider = createV2LiveCollectionProvider({
    liveEnabled: true,
    naverSearchMode: overrides.naverSearchMode || NAVER_SEARCH_MODES.internalWeb,
    naverApiHubKeyId: overrides.naverApiHubKeyId,
    naverApiHubKey: overrides.naverApiHubKey,
    naverApiHubSort: overrides.naverApiHubSort,
    approvalManifest: manifest,
    liveApprovalTokenSha256: overrides.approvalDigest || approvalManifestDigest(manifest),
    quotaRepository: durableQuota,
    seedSourceUrl: overrides.seedSourceUrl || `https://${FIXTURE_HOST}/approved-seed`,
    approvedProviders: overrides.approvedProviders || Object.values(PROVIDER_KEYS),
    killSwitches: { ...allRunning, ...(overrides.killSwitches || {}) },
    hostnameAllowlist: overrides.hostnameAllowlist || allAllowed,
    endpointBuilders: { ...endpointBuilders(), ...(overrides.endpointBuilders || {}) },
    otaProviders: overrides.otaProviders || [PROVIDER_KEYS.nol, PROVIDER_KEYS.ddnayo],
    requestedStages: overrides.requestedStages,
    requestBudget,
    timeoutMs: overrides.timeoutMs ?? 100,
    maxAttempts: overrides.maxAttempts ?? 2,
    baseBackoffMs: overrides.baseBackoffMs ?? 10,
    maximumBackoffMs: overrides.maximumBackoffMs ?? 50,
    maximumProducts: 4,
    clock: overrides.clock || (() => FIXED_NOW),
    sleep: overrides.sleep || (async (milliseconds, context) => {
      sleeps.push({ milliseconds, context });
    }),
    transport: fakeTransport
  });
  return { provider, calls, sleeps, transport: fakeTransport, quotaRepository: durableQuota, manifest };
}

async function expectFailure(promise, expectedCode, expectedCategory) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, expectedCode);
    if (expectedCategory) assert.equal(error.category, expectedCategory);
    return true;
  });
}

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test("factory is fail-closed and performs no transport call without live enablement", async () => {
  let calls = 0;
  const transport = async () => {
    calls += 1;
    return { status: 200, body: searchHtml() };
  };
  const disabled = createV2LiveCollectionProvider({ transport });
  await expectFailure(
    disabled.discover({ clientRequestId: "request-disabled-001", targetName: "실제 숙소", targetDate: "2026-08-01" }),
    "V2_LIVE_DISABLED",
    "configuration"
  );
  assert.equal(calls, 0);

  const unapproved = createV2LiveCollectionProvider({
    liveEnabled: true,
    approvedProviders: [PROVIDER_KEYS.naverSearch],
    killSwitches: { [PROVIDER_KEYS.naverSearch]: false },
    hostnameAllowlist: { [PROVIDER_KEYS.naverSearch]: [FIXTURE_HOST] },
    endpointBuilders: endpointBuilders(),
    requestBudget: { perRun: 1, perDay: 1 },
    transport
  });
  await expectFailure(
    unapproved.discover({ clientRequestId: "request-unapproved-001", targetName: "실제 숙소", targetDate: "2026-08-01" }),
    "V2_LIVE_APPROVAL_REQUIRED",
    "approval"
  );
  assert.equal(calls, 0);
});

test("extracts the bounded V2 Naver Apollo search contract", () => {
  const parsed = parseNaverSearchPayload(searchHtml(), { query: "실제 숙소" });
  assert.equal(parsed.total, 1);
  assert.deepEqual(parsed.items[0], {
    placeId: "place-100",
    bookingBusinessId: "booking-100",
    name: "실제 숙소",
    category: "글램핑",
    address: "경남 거창군 테스트로 1",
    rank: 1,
    reviewCount: 321,
    rating: 4.8,
    price: 150000,
    hasBooking: true,
    latitude: 35.5678,
    longitude: 127.1234,
    url: "https://pcmap.place.naver.com/accommodation/place-100",
    ad: false
  });
});

test("uses only the official API HUB Local Search contract for fast discovery and quick", async () => {
  const keyId = "test-api-hub-key-id-not-real";
  const apiKey = "test-api-hub-secret-not-real";
  const transportCalls = [];
  const requestBudget = { perRun: 5, perDay: 10 };
  const manifest = officialApprovalManifest(requestBudget);
  const transport = Object.assign(async (request) => {
    transportCalls.push({ ...request, signal: undefined });
    return { status: 200, headers: {}, url: request.url, body: apiHubLocalPayload() };
  }, { transportKind: "injected" });
  const harness = createHarness({
    naverSearchMode: NAVER_SEARCH_MODES.apiHub,
    naverApiHubKeyId: keyId,
    naverApiHubKey: apiKey,
    naverApiHubSort: "comment",
    approvalManifest: manifest,
    requestBudget,
    approvedProviders: [PROVIDER_KEYS.naverSearch],
    requestedStages: ["discovery", "quick"],
    otaProviders: [],
    seedSourceUrl: NAVER_API_HUB_LOCAL_ENDPOINT,
    hostnameAllowlist: { [PROVIDER_KEYS.naverSearch]: [NAVER_API_HUB_LOCAL_HOST, "pcmap.place.naver.com"] },
    endpointBuilders: {
      search() {
        throw new Error("api-hub mode must never build an internal-web request");
      }
    },
    transport
  });
  const input = {
    clientRequestId: "request-api-hub-fast-001",
    targetName: "Official Stay & Spa",
    regionCode: "seoul",
    regionLabel: "Seoul",
    targetDate: "2026-08-01"
  };
  const discovery = await harness.provider.discover(input);
  const quick = await harness.provider.collectQuick(input);

  assert.equal(transportCalls.length, 1, "discovery and quick reuse one exact-query response");
  assert.equal(harness.quotaRepository.rows.length, 1, "the one outbound request consumes one durable quota reservation");
  const request = transportCalls[0];
  const url = new URL(request.url);
  assert.equal(request.method, "GET");
  assert.equal(url.hostname, NAVER_API_HUB_LOCAL_HOST);
  assert.equal(url.pathname, "/search/v1/local");
  assert.equal(url.searchParams.get("query"), "Official Stay & Spa");
  assert.equal(url.searchParams.get("display"), "5");
  assert.equal(url.searchParams.get("start"), "1");
  assert.equal(url.searchParams.get("sort"), "comment");
  assert.equal(request.headers["X-NCP-APIGW-API-KEY-ID"], keyId);
  assert.equal(request.headers["X-NCP-APIGW-API-KEY"], apiKey);
  assert.equal(transportCalls.some((row) => row.url.includes("pcmap.place.naver.com")), false);
  assert.match(discovery.candidate.placeId, /^local_[a-f0-9]{64}$/);
  assert.deepEqual(discovery.candidate.externalIdentities, [{
    source: "naver-api-hub-local",
    externalId: discovery.candidate.placeId
  }]);
  assert.equal(discovery.candidate.companyName, "Official Stay & Spa");
  assert.equal(discovery.candidate.address, "Seoul Jung-gu Test-ro 1");
  assert.equal(discovery.candidate.mapx, "311277");
  assert.equal(discovery.candidate.mapy, "552097");
  assert.equal(quick.profile.category, "Lodging>Pension");
  assert.equal(quick.profile.latitude, null, "API HUB mapx/mapy must not be mislabeled as WGS84 latitude/longitude");
  const publicOutputs = JSON.stringify({
    discovery,
    quick,
    diagnostics: harness.provider.diagnostics(),
    quota: harness.quotaRepository.rows
  });
  assert.equal(publicOutputs.includes(keyId), false);
  assert.equal(publicOutputs.includes(apiKey), false);
  assert.equal(harness.provider.diagnostics().naverSearchMode, NAVER_SEARCH_MODES.apiHub);
  assert.deepEqual(harness.provider.diagnostics().hostnameAllowlist[PROVIDER_KEYS.naverSearch], [NAVER_API_HUB_LOCAL_HOST]);

  await expectFailure(harness.provider.collectDetail(input), "V2_LIVE_STAGE_NOT_APPROVED", "approval");
  assert.equal(transportCalls.length, 1, "fast scope must not invoke detail, OTA or an internal search fallback");
});

test("normalizes API HUB markup and creates a credential-independent stable public identity", () => {
  const payload = apiHubLocalPayload();
  const first = parseNaverApiHubLocalPayload(payload);
  const second = parseNaverApiHubLocalPayload(JSON.parse(JSON.stringify(payload)));
  assert.equal(first.items[0].name, "Official Stay & Spa");
  assert.equal(first.items[0].title, "Official Stay & Spa");
  assert.equal(first.items[0].link, "https://example.invalid/official-stay");
  assert.equal(first.items[0].address, "Seoul Jung-gu Test-dong 1");
  assert.equal(first.items[0].roadAddress, "Seoul Jung-gu Test-ro 1");
  assert.equal(first.items[0].category, "Lodging>Pension");
  assert.equal(first.items[0].mapx, "311277");
  assert.equal(first.items[0].mapy, "552097");
  assert.equal(first.items[0].placeId, second.items[0].placeId);
  assert.match(first.items[0].placeId, /^local_[a-f0-9]{64}$/);
});

test("fails API HUB closed for credentials, host, 401 and 429 without leaking secrets", async () => {
  const requestBudget = { perRun: 5, perDay: 10 };
  const manifest = officialApprovalManifest(requestBudget);
  const common = {
    naverSearchMode: NAVER_SEARCH_MODES.apiHub,
    approvalManifest: manifest,
    requestBudget,
    approvedProviders: [PROVIDER_KEYS.naverSearch],
    requestedStages: ["discovery", "quick"],
    otaProviders: [],
    seedSourceUrl: NAVER_API_HUB_LOCAL_ENDPOINT,
    hostnameAllowlist: { [PROVIDER_KEYS.naverSearch]: [NAVER_API_HUB_LOCAL_HOST] },
    maxAttempts: 1
  };
  const input = {
    clientRequestId: "request-api-hub-gate-001",
    targetName: "Official Stay & Spa",
    regionCode: "seoul",
    regionLabel: "Seoul",
    targetDate: "2026-08-01"
  };

  let missingCredentialCalls = 0;
  const missing = createHarness({
    ...common,
    transport: async () => {
      missingCredentialCalls += 1;
      return { status: 200, body: apiHubLocalPayload() };
    }
  });
  assert.equal(missing.provider.enabled, false);
  assert(missing.provider.diagnostics().reasons.includes("naver-api-hub-credentials-missing"));
  await expectFailure(missing.provider.discover(input), "V2_LIVE_NAVER_API_HUB_CONFIGURATION_REQUIRED", "configuration");
  assert.equal(missingCredentialCalls, 0);

  let wrongHostCalls = 0;
  const wrongHost = createHarness({
    ...common,
    naverApiHubKeyId: "id-not-real",
    naverApiHubKey: "secret-not-real",
    endpointBuilders: {
      apiHubSearch: () => "https://pcmap.place.naver.com/accommodation/list?query=Official%20Stay"
    },
    transport: async () => {
      wrongHostCalls += 1;
      return { status: 200, body: apiHubLocalPayload() };
    }
  });
  await expectFailure(wrongHost.provider.discover(input), "V2_LIVE_HOST_NOT_ALLOWED", "configuration");
  assert.equal(wrongHostCalls, 0);

  for (const testCase of [
    { status: 401, code: "V2_PROVIDER_AUTH", category: "auth" },
    { status: 429, code: "V2_PROVIDER_RATE_LIMITED", category: "rate-limit" }
  ]) {
    let calls = 0;
    const gated = createHarness({
      ...common,
      naverApiHubKeyId: "status-id-not-real",
      naverApiHubKey: "status-secret-not-real",
      transport: async (request) => {
        calls += 1;
        return { status: testCase.status, headers: { "retry-after": "1" }, url: request.url, body: { error: "denied" } };
      }
    });
    await expectFailure(gated.provider.discover({ ...input, clientRequestId: `${input.clientRequestId}-${testCase.status}` }), testCase.code, testCase.category);
    assert.equal(calls, 1);
  }

  const keyId = "leak-check-id-not-real";
  const apiKey = "leak-check-secret-not-real";
  const leakingTransport = createHarness({
    ...common,
    naverApiHubKeyId: keyId,
    naverApiHubKey: apiKey,
    transport: async () => {
      throw new Error(`transport failed for ${keyId} and ${apiKey}`);
    }
  });
  await assert.rejects(leakingTransport.provider.discover({ ...input, clientRequestId: "request-api-hub-leak-check" }), (error) => {
    const serialized = JSON.stringify({ message: error.message, details: error.details, diagnostics: leakingTransport.provider.diagnostics() });
    assert.equal(serialized.includes(keyId), false);
    assert.equal(serialized.includes(apiKey), false);
    return true;
  });
});

test("provides live quick-detail-OTA shapes without synthetic attribution", async () => {
  const { provider, calls } = createHarness();
  const input = {
    clientRequestId: "request-live-flow-001",
    targetName: "실제 숙소",
    regionLabel: "경남 거창군",
    rankingQuery: "거창 글램핑",
    targetDate: "2026-08-01"
  };
  const discovery = await provider.discover(input);
  const quick = await provider.collectQuick(input);
  const detail = await provider.collectDetail(input);
  const ota = await provider.collectOta(input);

  assert.equal(discovery.provider, LIVE_PROVIDER_ID);
  assert.equal(discovery.providerMode, "live");
  assert.equal(discovery.dataMode, "live");
  assert.equal(discovery.synthetic, false);
  assert.equal(discovery.candidate.placeId, "place-100");
  assert.deepEqual(discovery.candidate.externalIdentities, [
    { source: "naver-place", externalId: "place-100" },
    { source: "naver-booking", externalId: "booking-100" }
  ]);
  assert.equal(quick.synthetic, false);
  assert.equal(quick.dataMode, "live");
  assert.equal(quick.profile.rank, 1);
  assert.equal(quick.profile.reviewCount, 321);
  assert.match(quick.profile.rankingCondition.conditionHash, /^[a-f0-9]{64}$/);
  assert.match(quick.profile.rankingCondition.requestKey, /^v2req_[a-f0-9]{64}$/);
  assert.equal(detail.synthetic, false);
  assert.equal(detail.dataMode, "live");
  assert.deepEqual(detail.products, [{
    productKey: "naver:item-100",
    targetDate: "2026-08-01",
    price: 150000,
    totalStock: 5,
    availableStock: 3,
    productName: "기본 객실",
    bookingBusinessId: "booking-100",
    sourceItemId: "item-100"
  }]);
  assert.equal(ota.synthetic, false);
  assert.equal(ota.dataMode, "live");
  assert.deepEqual(ota.channels.map(({ provider, sourceUrl, requestKey, ...row }) => row), [
    { channel: "yanolja-nol", productKey: "company", targetDate: "2026-08-01", exposed: true },
    { channel: "ddnayo", productKey: "company", targetDate: "2026-08-01", exposed: true }
  ]);
  assert.deepEqual(ota.channels.map((row) => row.provider), [PROVIDER_KEYS.nol, PROVIDER_KEYS.ddnayo]);
  assert(ota.channels.every((row) => row.sourceUrl.startsWith(`https://${FIXTURE_HOST}/ota/`) && /^v2req_[a-f0-9]{64}$/.test(row.requestKey)));
  assert.equal(calls.filter((call) => call.operation === "naver-search").length, 2, "discovery and ranking use separate exact-query conditions");
  assert.equal(provider.diagnostics().externalNetworkCalls, 0, "injected fake transport is not a real network transport");
  assert.equal(provider.enabled, true);
  assert.equal(provider.synthetic, false);
  assert.equal(provider.dataMode, "live");
  assert.equal(provider.seedSourceUrl, `https://${FIXTURE_HOST}/approved-seed`);
});

test("keeps request keys stable and run-scoped", () => {
  const first = stableRequestKey({
    runKey: "run-1",
    provider: PROVIDER_KEYS.naverBooking,
    method: "POST",
    url: `https://${FIXTURE_HOST}/graphql`,
    body: { b: 2, a: 1 }
  });
  const reordered = stableRequestKey({
    runKey: "run-1",
    provider: PROVIDER_KEYS.naverBooking,
    method: "POST",
    url: `https://${FIXTURE_HOST}/graphql`,
    body: JSON.stringify({ a: 1, b: 2 })
  });
  const otherRun = stableRequestKey({
    runKey: "run-2",
    provider: PROVIDER_KEYS.naverBooking,
    method: "POST",
    url: `https://${FIXTURE_HOST}/graphql`,
    body: { a: 1, b: 2 }
  });
  const apiHubRequest = {
    runKey: "run-api-hub",
    provider: PROVIDER_KEYS.naverSearch,
    method: "GET",
    url: `${NAVER_API_HUB_LOCAL_ENDPOINT}?query=Official+Stay&display=5&start=1&sort=random`
  };
  const apiHubWithoutCredentials = stableRequestKey(apiHubRequest);
  const apiHubWithRotatedCredentials = stableRequestKey({
    ...apiHubRequest,
    headers: {
      "X-NCP-APIGW-API-KEY-ID": "rotated-id-not-real",
      "X-NCP-APIGW-API-KEY": "rotated-key-not-real"
    }
  });
  assert.equal(first, reordered);
  assert.equal(apiHubWithoutCredentials, apiHubWithRotatedCredentials, "credentials must not enter durable request keys or audit identity");
  assert.notEqual(first, otherRun);
});

test("enforces per-run and daily request budgets before transport", async () => {
  const perRun = createHarness({ requestBudget: { perRun: 1, perDay: 10 }, maxAttempts: 1 });
  const input = { clientRequestId: "request-budget-run", targetName: "실제 숙소", targetDate: "2026-08-01" };
  await perRun.provider.discover(input);
  await expectFailure(perRun.provider.collectDetail(input), "V2_LIVE_REQUEST_BUDGET_EXCEEDED", "quota");
  assert.equal(perRun.calls.length, 1);

  const daily = createHarness({ requestBudget: { perRun: 5, perDay: 1 }, maxAttempts: 1 });
  await daily.provider.discover({ ...input, clientRequestId: "request-budget-day-1" });
  await expectFailure(
    daily.provider.discover({ ...input, clientRequestId: "request-budget-day-2" }),
    "V2_LIVE_REQUEST_BUDGET_EXCEEDED",
    "quota"
  );
  assert.equal(daily.calls.length, 1);
});

test("provider-specific kill switches and host allowlists fail before transport", async () => {
  const killed = createHarness({ killSwitches: { [PROVIDER_KEYS.naverSearch]: true } });
  await expectFailure(
    killed.provider.discover({ clientRequestId: "request-killed-001", targetName: "실제 숙소", targetDate: "2026-08-01" }),
    "V2_LIVE_KILL_SWITCH_OPEN",
    "kill-switch"
  );
  assert.equal(killed.calls.length, 0);

  const deniedHost = createHarness({
    hostnameAllowlist: {
      [PROVIDER_KEYS.naverSearch]: [],
      [PROVIDER_KEYS.naverBooking]: [FIXTURE_HOST],
      [PROVIDER_KEYS.nol]: [FIXTURE_HOST],
      [PROVIDER_KEYS.ddnayo]: [FIXTURE_HOST]
    }
  });
  await expectFailure(
    deniedHost.provider.discover({ clientRequestId: "request-host-001", targetName: "실제 숙소", targetDate: "2026-08-01" }),
    "V2_LIVE_HOST_NOT_ALLOWED",
    "configuration"
  );
  assert.equal(deniedHost.calls.length, 0);

  const cached = createHarness();
  const cachedInput = { clientRequestId: "request-cached-kill-001", targetName: "실제 숙소", targetDate: "2026-08-01" };
  await cached.provider.discover(cachedInput);
  cached.provider.setKillSwitch(PROVIDER_KEYS.naverSearch, true);
  await expectFailure(
    cached.provider.collectQuick(cachedInput),
    "V2_LIVE_KILL_SWITCH_OPEN",
    "kill-switch"
  );
  assert.equal(cached.calls.length, 1, "cached provider data must not bypass a newly opened kill switch");
});

test("enabled metadata is conservative and reports readiness reasons", () => {
  const partial = createHarness({ approvedProviders: [PROVIDER_KEYS.naverSearch] });
  assert.equal(partial.provider.enabled, false);
  const partialDiagnostics = partial.provider.diagnostics();
  assert.equal(partialDiagnostics.ready, false);
  assert(partialDiagnostics.reasons.includes(`provider-not-approved:${PROVIDER_KEYS.naverBooking}`));
  assert(partialDiagnostics.reasons.includes(`provider-not-approved:${PROVIDER_KEYS.nol}`));
  assert(partialDiagnostics.reasons.includes(`provider-not-approved:${PROVIDER_KEYS.ddnayo}`));

  const searchOnly = createHarness({
    approvedProviders: [PROVIDER_KEYS.naverSearch],
    requestedStages: ["discovery", "quick"]
  });
  assert.equal(searchOnly.provider.enabled, true);
  assert.deepEqual(searchOnly.provider.diagnostics().requiredProviders, [PROVIDER_KEYS.naverSearch]);

  const full = createHarness();
  assert.equal(full.provider.enabled, true);
  full.provider.setKillSwitch(PROVIDER_KEYS.nol, true);
  assert.equal(full.provider.enabled, false);
  assert(full.provider.diagnostics().reasons.includes(`kill-switch-open:${PROVIDER_KEYS.nol}`));
  full.provider.setKillSwitch(PROVIDER_KEYS.nol, false);
  assert.equal(full.provider.enabled, true);
});

test("approval digest binds target, expiry, provider stages, request caps and cost", async () => {
  const manifest = approvalManifest();
  const digest = approvalManifestDigest(manifest);
  const variants = [
    { ...manifest, expiresAt: "2026-08-29T00:00:00.000Z" },
    { ...manifest, targets: [{ ...manifest.targets[0], targetName: "different target" }, ...manifest.targets.slice(1)] },
    { ...manifest, providers: manifest.providers.filter((provider) => provider !== PROVIDER_KEYS.ddnayo) },
    {
      ...manifest,
      providerCaps: {
        ...manifest.providerCaps,
        [PROVIDER_KEYS.naverSearch]: {
          ...manifest.providerCaps[PROVIDER_KEYS.naverSearch],
          stages: ["quick", "discovery", "detail"]
        }
      }
    },
    { ...manifest, requestCaps: { ...manifest.requestCaps, perRun: manifest.requestCaps.perRun + 1 } },
    { ...manifest, cost: { ...manifest.cost, maximumCostMicros: 1 } }
  ];
  for (const variant of variants) assert.notEqual(approvalManifestDigest(variant), digest);
  const missingExplicitCost = JSON.parse(JSON.stringify(manifest));
  delete missingExplicitCost.providerCaps[PROVIDER_KEYS.nol].costMicros;
  assert.throws(
    () => approvalManifestDigest(missingExplicitCost),
    (error) => error.code === "V2_LIVE_APPROVAL_MANIFEST_INVALID"
  );

  const wrongDigest = createHarness({ approvalManifest: manifest, approvalDigest: "f".repeat(64) });
  await expectFailure(
    wrongDigest.provider.discover({
      clientRequestId: "request-wrong-approval-digest",
      targetName: "실제 숙소",
      targetDate: "2026-08-01"
    }),
    "V2_LIVE_APPROVAL_REQUIRED",
    "approval"
  );
  assert.equal(wrongDigest.calls.length, 0);

  const budgetMismatch = createHarness({
    approvalManifest: manifest,
    requestBudget: { perRun: manifest.requestCaps.perRun - 1, perDay: manifest.requestCaps.perDay }
  });
  await expectFailure(
    budgetMismatch.provider.discover({
      clientRequestId: "request-budget-manifest-mismatch",
      targetName: "실제 숙소",
      targetDate: "2026-08-01"
    }),
    "V2_LIVE_BUDGET_MANIFEST_MISMATCH",
    "quota"
  );
  assert.equal(budgetMismatch.calls.length, 0);

  const stageRestrictedManifest = JSON.parse(JSON.stringify(manifest));
  stageRestrictedManifest.providerCaps[PROVIDER_KEYS.naverSearch].stages = ["discovery", "quick"];
  const stageRestricted = createHarness({ approvalManifest: stageRestrictedManifest });
  await expectFailure(
    stageRestricted.provider.collectDetail({
      clientRequestId: "request-provider-stage-restricted",
      targetName: "실제 숙소",
      targetDate: "2026-08-01"
    }),
    "V2_LIVE_STAGE_NOT_APPROVED",
    "approval"
  );
  assert.equal(stageRestricted.calls.length, 0);

  const weeklyScopeInput = {
    clientRequestId: "request-weekly-scope",
    targetName: "실제 숙소",
    targetDate: "2026-08-01",
    checkIn: "2026-08-01",
    checkOut: "2026-08-02"
  };
  assert.throws(
    () => createHarness({ approvalManifest: manifest }).provider.assertRequestScope(
      weeklyScopeInput,
      ["discovery", "quick", "detail", "ota", "finalize"],
      { collectWeeklyRange: true, checkIn: "2026-08-01", checkOut: "2026-08-02" }
    ),
    (error) => error.code === "V2_LIVE_TARGET_NOT_APPROVED"
  );
  const weeklyManifest = JSON.parse(JSON.stringify(manifest));
  weeklyManifest.targets.forEach((target) => { target.targetDates = ["2026-08-01", "2026-08-02"]; });
  const weeklyApproved = createHarness({ approvalManifest: weeklyManifest });
  assert.deepEqual(weeklyApproved.provider.assertRequestScope(
    weeklyScopeInput,
    ["discovery", "quick", "detail", "ota", "finalize"],
    { collectWeeklyRange: true, checkIn: "2026-08-01", checkOut: "2026-08-02" }
  ).detailTargetDates, ["2026-08-01", "2026-08-02"]);
  assert.equal(weeklyApproved.calls.length, 0);
  const boundedRevenuePlan = {
    collectWeeklyRange: true,
    checkIn: "2026-08-01",
    checkOut: "2026-08-02",
    requestEstimate: { discovery: 1, quick: 1, detail: 10, leadtime: 70, ota: 2, total: 84 }
  };
  assert.throws(
    () => weeklyApproved.provider.assertRequestScope(
      weeklyScopeInput,
      ["discovery", "quick", "detail", "ota", "finalize"],
      boundedRevenuePlan
    ),
    (error) => error.code === "V2_LIVE_PLAN_BUDGET_INSUFFICIENT"
  );
  const sufficientWeeklyManifest = approvalManifest({ perRun: 100, perDay: 100 });
  sufficientWeeklyManifest.targets.forEach((target) => { target.targetDates = ["2026-08-01", "2026-08-02"]; });
  const sufficientWeekly = createHarness({
    approvalManifest: sufficientWeeklyManifest,
    requestBudget: { perRun: 100, perDay: 100 }
  });
  assert.equal(sufficientWeekly.provider.assertRequestScope(
    weeklyScopeInput,
    ["discovery", "quick", "detail", "ota", "finalize"],
    boundedRevenuePlan
  ).estimatedRequestTotal, 84);
  assert.equal(sufficientWeekly.calls.length, 0);

  const expired = createHarness({
    approvalManifest: { ...manifest, expiresAt: "2026-07-30T01:02:03.000Z" }
  });
  await expectFailure(
    expired.provider.discover({
      clientRequestId: "request-expired-approval",
      targetName: "실제 숙소",
      targetDate: "2026-08-01"
    }),
    "V2_LIVE_APPROVAL_EXPIRED",
    "approval"
  );
  assert.equal(expired.calls.length, 0);
});

test("classifies timeout, auth, forbidden, empty and schema failures", async () => {
  const cases = [
    { status: 401, body: {}, code: "V2_PROVIDER_AUTH", category: "auth" },
    { status: 403, body: {}, code: "V2_PROVIDER_FORBIDDEN", category: "forbidden" },
    { status: 200, body: "", code: "V2_PROVIDER_EMPTY", category: "empty" },
    { status: 200, body: { unexpected: true }, code: "V2_PROVIDER_SCHEMA", category: "schema" }
  ];
  for (const [index, testCase] of cases.entries()) {
    const calls = [];
    const transport = async (request) => {
      calls.push(request);
      return { status: testCase.status, headers: {}, url: request.url, body: testCase.body };
    };
    const harness = createHarness({ transport, maxAttempts: 1 });
    await expectFailure(
      harness.provider.discover({ clientRequestId: `request-error-${index}`, targetName: "실제 숙소", targetDate: "2026-08-01" }),
      testCase.code,
      testCase.category
    );
    assert.equal(calls.length, 1);
  }

  const timeoutTransport = async () => new Promise(() => {});
  const timed = createHarness({ transport: timeoutTransport, timeoutMs: 5, maxAttempts: 1 });
  await expectFailure(
    timed.provider.discover({ clientRequestId: "request-timeout-001", targetName: "실제 숙소", targetDate: "2026-08-01" }),
    "V2_PROVIDER_TIMEOUT",
    "timeout"
  );
});

test("rejects wrong Apollo query, low-score identity and region mismatch", async () => {
  const wrongQuery = createHarness({
    maxAttempts: 1,
    transport: async (request) => ({
      status: 200,
      headers: {},
      url: request.url,
      body: searchHtml("different-query", "실제 숙소")
    })
  });
  await expectFailure(
    wrongQuery.provider.discover({ clientRequestId: "request-wrong-query", targetName: "실제 숙소", targetDate: "2026-08-01" }),
    "V2_PROVIDER_SCHEMA",
    "schema"
  );

  const lowScore = createHarness({
    maxAttempts: 1,
    transport: async (request) => ({
      status: 200,
      headers: {},
      url: request.url,
      body: { items: [{ id: "unrelated-1", name: "무관한 호텔", commonAddress: "경남 거창군" }] }
    })
  });
  await expectFailure(
    lowScore.provider.discover({ clientRequestId: "request-low-score", targetName: "실제 숙소", targetDate: "2026-08-01" }),
    "V2_PROVIDER_COMPANY_MATCH_REJECTED",
    "identity"
  );

  const wrongRegion = createHarness({
    maxAttempts: 1,
    transport: async (request) => ({
      status: 200,
      headers: {},
      url: request.url,
      body: { items: [{ id: "place-100", name: "실제 숙소", commonAddress: "서울 중구" }] }
    })
  });
  await expectFailure(
    wrongRegion.provider.discover({
      clientRequestId: "request-wrong-region",
      targetName: "실제 숙소",
      regionLabel: "경남 거창군",
      targetDate: "2026-08-01"
    }),
    "V2_PROVIDER_COMPANY_MATCH_REJECTED",
    "identity"
  );
});

test("classifies HTTP-200 GraphQL errors and provider challenge pages", async () => {
  const graphql = createHarness({
    maxAttempts: 1,
    transport: async (request) => {
      if (request.operation === "naver-search") return defaultFakeResponse(request);
      if (request.operation === "naver-booking-items") {
        return { status: 200, headers: {}, url: request.url, body: { errors: [{ message: "Unauthorized booking request" }] } };
      }
      return defaultFakeResponse(request);
    }
  });
  await expectFailure(
    graphql.provider.collectDetail({ clientRequestId: "request-graphql-error", targetName: "실제 숙소", targetDate: "2026-08-01" }),
    "V2_PROVIDER_AUTH",
    "auth"
  );

  const challenge = createHarness({
    maxAttempts: 1,
    transport: async (request) => ({
      status: 200,
      headers: {},
      url: request.url,
      body: "<html><title>WtmCaptcha</title><p>temporarily blocked</p></html>"
    })
  });
  await expectFailure(
    challenge.provider.discover({ clientRequestId: "request-captcha-page", targetName: "실제 숙소", targetDate: "2026-08-01" }),
    "V2_PROVIDER_CHALLENGE",
    "auth"
  );
});

test("rejects normalized impossible calendar dates and unapproved targets before transport", async () => {
  const harness = createHarness();
  await expectFailure(
    harness.provider.discover({ clientRequestId: "request-bad-date", targetName: "실제 숙소", targetDate: "2026-02-31" }),
    "V2_LIVE_TARGET_DATE_INVALID",
    "input"
  );
  await expectFailure(
    harness.provider.discover({ clientRequestId: "request-unapproved-target", targetName: "승인되지 않은 숙소", targetDate: "2026-08-01" }),
    "V2_LIVE_TARGET_NOT_APPROVED",
    "approval"
  );
  assert.equal(harness.calls.length, 0);
});

test("honors Retry-After with bounded backoff and retries once", async () => {
  let attempts = 0;
  const calls = [];
  const sleeps = [];
  const transport = async (request) => {
    calls.push(request);
    attempts += 1;
    if (attempts === 1) {
      return { status: 429, headers: { "Retry-After": "2" }, url: request.url, body: { error: "limited" } };
    }
    return defaultFakeResponse(request);
  };
  const harness = createHarness({
    transport,
    maxAttempts: 2,
    baseBackoffMs: 10,
    maximumBackoffMs: 25,
    sleep: async (milliseconds, context) => sleeps.push({ milliseconds, context })
  });
  const result = await harness.provider.discover({
    clientRequestId: "request-retry-001",
    targetName: "실제 숙소",
    targetDate: "2026-08-01"
  });
  assert.equal(result.candidate.placeId, "place-100");
  assert.equal(calls.length, 2);
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0].milliseconds, 2000, "Retry-After is a minimum delay and must not be truncated by local backoff caps");
  assert.equal(parseRetryAfterMs({ "retry-after": "2" }, () => FIXED_NOW), 2000);
  assert.equal(boundedBackoffMs({ attempt: 3, baseMs: 100, maximumMs: 250 }), 250);
});

test("does not infer stock when the live schedule is absent", () => {
  const products = normalizeBookingProducts([
    { bizItemId: "no-schedule", name: "미수집 객실", price: 110000 }
  ], new Map(), "2026-08-01", 4);
  assert.equal(products[0].price, 110000);
  assert.equal(products[0].totalStock, null);
  assert.equal(products[0].availableStock, null);
});

test("provider module has no filesystem or legacy runtime dependency", () => {
  const sourcePath = path.join(__dirname, "integration", "services", "v2_live_collection_provider.cjs");
  const source = fs.readFileSync(sourcePath, "utf8");
  for (const forbidden of ["node:fs", "OUTPUTS_DIR", "COMPANY_MASTER_FILE", "HISTORY_OBSERVATIONS_FILE", "seedOutputsFromRepo"]) {
    assert.equal(source.includes(forbidden), false, `provider source must not include ${forbidden}`);
  }
  assert.equal(source.includes("synthetic: true"), false, "live results must never be marked synthetic");
});

async function main() {
  const originalFetch = globalThis.fetch;
  let realNetworkCalls = 0;
  globalThis.fetch = async () => {
    realNetworkCalls += 1;
    throw new Error("Real network is forbidden in v2 live provider tests");
  };
  let passed = 0;
  try {
    for (const entry of tests) {
      await entry.run();
      passed += 1;
      console.log(`PASS ${entry.name}`);
    }
    assert.equal(realNetworkCalls, 0, "tests must perform zero real network requests");
    console.log(`PASS v2 live collection provider (${passed} tests, real network calls: ${realNetworkCalls})`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
