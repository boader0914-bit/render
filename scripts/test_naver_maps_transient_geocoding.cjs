"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

let forbiddenGlobalFetchCalls = 0;
global.fetch = async () => {
  forbiddenGlobalFetchCalls += 1;
  throw new Error("global network access is forbidden in NAVER transient tests");
};

const {
  MAX_TRANSIENT_MONTHLY_REQUESTS,
  NAVER_MAPS_API_KEY_ENV,
  NAVER_MAPS_API_KEY_ID_ENV,
  NAVER_MAPS_GEOCODING_ENABLED_ENV,
  TRANSIENT_DISPLAY_VERSION,
  createMonthlyRequestBudget,
  createNaverMapsTransientGeocodingAdapter
} = require("./naver_maps_geocoding_adapter.cjs");
const {
  createNaverMapsTransientGeocodingService
} = require("./naver_maps_transient_geocoding.cjs");
const {
  createPersistentMonthlyRequestBudget
} = require("./naver_maps_geocoding_quota.cjs");

const ADDRESS = "\uacbd\uc0c1\ub0a8\ub3c4 \ud569\ucc9c\uad70 \uac00\ud68c\uba74 \uac00\ud68c\uc0b0\ub85c 1";
const TEST_KEY_ID = "fixture-id";
const TEST_KEY = "fixture-key";
const NOW = "2026-08-04T00:00:00.000Z";

function response(status, payload) {
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => String(name).toLowerCase() === "content-length" ? String(Buffer.byteLength(text)) : null },
    async text() { return text; }
  };
}

function naverPayload(addresses = []) {
  return { status: "OK", meta: { totalCount: addresses.length, page: 1, count: addresses.length }, addresses };
}

function naverRow(overrides = {}) {
  return {
    roadAddress: ADDRESS,
    jibunAddress: ADDRESS,
    x: "128.165",
    y: "35.566",
    addressElements: [{ types: ["ROAD_NAME"], longName: "\uac00\ud68c\uc0b0\ub85c" }],
    rawProviderSecret: "must-not-survive",
    ...overrides
  };
}

function transientAdapter(request, options = {}) {
  return createNaverMapsTransientGeocodingAdapter({
    env: {
      [NAVER_MAPS_GEOCODING_ENABLED_ENV]: "1",
      [NAVER_MAPS_API_KEY_ID_ENV]: TEST_KEY_ID,
      [NAVER_MAPS_API_KEY_ENV]: TEST_KEY
    },
    request,
    monthlyLimit: options.monthlyLimit || 10,
    now: options.now || (() => NOW),
    budget: options.budget
  });
}

async function main() {
  const disabled = createNaverMapsTransientGeocodingAdapter({ env: {}, request: async () => response(200, naverPayload()) });
  assert.equal(disabled.enabled, false, "missing opt-in and credentials must fail closed");
  assert.equal(disabled.configuration().usage, "transient-display-only");
  assert.equal(disabled.configuration().cacheable, false);
  assert.equal(disabled.configuration().persistable, false);

  const noApprovedLimit = createNaverMapsTransientGeocodingAdapter({
    env: {
      [NAVER_MAPS_GEOCODING_ENABLED_ENV]: "1",
      [NAVER_MAPS_API_KEY_ID_ENV]: TEST_KEY_ID,
      [NAVER_MAPS_API_KEY_ENV]: TEST_KEY
    },
    request: async () => response(200, naverPayload())
  });
  assert.equal(noApprovedLimit.enabled, false, "an explicit approved monthly limit is required before activation");
  assert.equal(noApprovedLimit.configuration().monthlyLimitApproved, false);

  let transportCalls = 0;
  let capturedUrl = "";
  let capturedOptions = null;
  const adapter = transientAdapter(async (url, options) => {
    transportCalls += 1;
    capturedUrl = url;
    capturedOptions = options;
    return response(200, naverPayload([naverRow()]));
  });
  const first = await adapter.resolveForDisplay({ normalizedAddress: ADDRESS, requestId: "display-1" });
  assert.equal(first.version, TRANSIENT_DISPLAY_VERSION);
  assert.equal(first.usage, "single-display");
  assert.equal(first.cacheable, false);
  assert.equal(first.persistable, false);
  assert.equal(first.results.length, 1);
  assert.equal(first.results[0].status, "approximate");
  assert.equal(first.results[0].latitude, 35.566);
  assert.equal(first.results[0].longitude, 128.165);
  assert.equal("rawProviderSecret" in first.results[0], false);
  assert.equal(new URL(capturedUrl).hostname, "maps.apigw.ntruss.com");
  assert.equal(new URL(capturedUrl).searchParams.get("query"), ADDRESS);
  assert.equal(capturedOptions.headers["x-ncp-apigw-api-key-id"], TEST_KEY_ID);
  assert.equal(capturedOptions.headers["x-ncp-apigw-api-key"], TEST_KEY);
  assert.equal(capturedOptions.redirect, "error");

  await adapter.resolveForDisplay({ normalizedAddress: ADDRESS, requestId: "display-1" });
  assert.equal(transportCalls, 2, "transient lookups must never replay a cached coordinate");

  let limitedCalls = 0;
  const limited = transientAdapter(async () => {
    limitedCalls += 1;
    return response(429, { status: "ERROR" });
  });
  await assert.rejects(
    limited.resolveForDisplay({ normalizedAddress: ADDRESS, requestId: "rate-limited" }),
    (error) => error.code === "NAVER_GEOCODING_RATE_LIMITED"
  );
  assert.equal(limitedCalls, 1, "429 responses must not be retried");

  const memoryBudget = createMonthlyRequestBudget({ limit: MAX_TRANSIENT_MONTHLY_REQUESTS + 5000, now: () => NOW });
  assert.equal(memoryBudget.snapshot().limit, MAX_TRANSIENT_MONTHLY_REQUESTS, "the app hard cap cannot exceed 10,000");

  let serviceCalls = 0;
  const serviceAdapter = transientAdapter(async () => {
    serviceCalls += 1;
    return response(200, naverPayload([naverRow()]));
  });
  const service = createNaverMapsTransientGeocodingService({ adapter: serviceAdapter, timeoutMs: 500 });
  const runData = {
    ranking: {
      items: [
        { name: "fixture", address: ADDRESS },
        { name: "missing-address" },
        { name: "stored", address: ADDRESS, location: { status: "resolved", lat: 37.5, lon: 127.1, source: "legacy", precision: "rooftop" } },
        { name: "stored-low-precision", address: ADDRESS, location: { status: "resolved", lat: 37.6, lon: 127.2, source: "legacy", precision: "unknown" } }
      ]
    }
  };
  const before = JSON.stringify(runData);
  const display = await service.resolveRunItemsForDisplay({ runData, itemIndexes: [0, 1, 2, 3] });
  assert.equal(display.version, "naver-maps-geocoding-transient-display/v2");
  assert.equal(display.usage, "single-display");
  assert.equal(display.cacheable, false);
  assert.equal(display.persistable, false);
  assert.equal(serviceCalls, 2, "resolved coordinates with unknown precision must be re-checked instead of treated as display-ready");
  assert.equal("providerKey" in display, false, "public service responses must not expose provider identity");
  assert.equal("providerCalls" in display, false, "public service responses must not expose internal call accounting");
  assert.equal(display.items[0].location.transient, true);
  assert.equal(display.items[0].location.status, "approximate");
  assert.equal(display.items[0].location.lat, 35.566);
  assert.equal(display.items[0].location.lon, 128.165);
  assert.equal(display.items[0].location.source, "naver-transient");
  assert.equal(display.items[1].location.status, "invalid");
  assert.equal(display.items[2].location.transient, false);
  assert.equal(display.items[3].location.transient, true);
  assert.equal(display.items[3].location.status, "approximate");
  assert.equal(display.items.every((item) => !("providerCall" in item)), true, "public item rows must not expose provider call metadata");
  assert.equal(display.items.every((item) => !("providerKey" in item.location)), true, "public locations must not expose provider identity");
  assert.equal(JSON.stringify(runData), before, "transient display resolution must not mutate run or company data");
  const serialized = JSON.stringify(display);
  for (const forbidden of [ADDRESS, "rawProviderSecret", TEST_KEY_ID, TEST_KEY, "addressElements", "resolvedAddress", "addressFingerprint"]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must not survive the public transient response`);
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "naver-geocode-quota-"));
  try {
    const ledgerPath = path.join(tempRoot, "quota.json");
    const quota = createPersistentMonthlyRequestBudget({ filePath: ledgerPath, limit: 1, now: () => NOW });
    const concurrent = await Promise.allSettled([quota.reserve(1), quota.reserve(1)]);
    assert.equal(concurrent.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((entry) => entry.status === "rejected" && entry.reason?.code === "NAVER_GEOCODING_MONTHLY_BUDGET_EXHAUSTED").length, 1);
    const persisted = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    assert.deepEqual(Object.keys(persisted).sort(), ["month", "schemaVersion", "used"]);
    assert.equal(persisted.used, 1);
    const ledgerText = JSON.stringify(persisted);
    for (const forbidden of [ADDRESS, "latitude", "longitude", "company", "query", TEST_KEY_ID, TEST_KEY]) {
      assert.equal(ledgerText.includes(forbidden), false, `quota ledger must not contain ${forbidden}`);
    }
    const restarted = createPersistentMonthlyRequestBudget({ filePath: ledgerPath, limit: 1, now: () => NOW });
    await assert.rejects(restarted.reserve(1), (error) => error.code === "NAVER_GEOCODING_MONTHLY_BUDGET_EXHAUSTED");

    const nextMonth = createPersistentMonthlyRequestBudget({
      filePath: ledgerPath,
      limit: 1,
      now: () => "2026-09-01T00:00:00.000Z"
    });
    const rolled = await nextMonth.reserve(1);
    assert.equal(rolled.month, "2026-09");
    assert.equal(rolled.used, 1);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  assert.equal(forbiddenGlobalFetchCalls, 0, "tests must never reach a real provider");
  console.log("NAVER transient display, no-persistence, no-cache, no-retry, and monthly quota tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
