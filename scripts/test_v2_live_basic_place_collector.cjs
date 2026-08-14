"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  APPROVAL_TOKEN,
  LIVE_ENV_NAMES,
  SCHEMA_VERSION,
  V2BasicPlaceError,
  executeBasicPlaceJob,
  sha256
} = require("./v2_live_basic_place_collector.cjs");

const KEYWORD = "경남 글램핑";

function entity(state, key, value) {
  state[key] = value;
  return { __ref: key };
}

function fixtureHtml() {
  const state = { ROOT_QUERY: {} };
  const shared = entity(state, "Place:35644668", {
    id: "35644668",
    name: "월명 글램핑",
    category: "캠핑,야영장",
    roadAddress: "경상남도 산청군 fixture-road",
    commonAddress: "경남 산청군",
    hasBooking: true,
    placeReviewScore: 4.8,
    placeReviewCount: 120,
    totalReviewCount: 150,
    roomImages: [entity(state, "Room:1", { name: "글램핑 A", minPrice: 120000, maxPrice: 150000 })]
  });
  const organicTwo = entity(state, "Place:200", {
    id: "200",
    name: "두번째 글램핑",
    category: "펜션",
    jibunAddress: "경상남도 거창군 fixture-jibun",
    hasBooking: false,
    matchRoomMinPrice: 90000,
    roomImages: []
  });
  const adTwo = entity(state, "Ad:300", {
    id: "300",
    name: "광고 글램핑",
    category: "캠핑,야영장",
    address: "경상남도 합천군 fixture-address",
    adId: "fixture-ad-2",
    adDescription: "광고 fixture"
  });
  state.ROOT_QUERY[`accommodationSearch(${JSON.stringify({ input: { query: KEYWORD, display: 50 } })})`] = {
    business: { items: [shared, organicTwo], total: 2 }
  };
  state.ROOT_QUERY[`adBusinesses(${JSON.stringify({ input: { query: KEYWORD, businessType: "accommodation" } })})`] = {
    items: [shared, adTwo],
    total: 2
  };
  return `<html><script>window.__APOLLO_STATE__=${JSON.stringify(state)};</script></html>`;
}

function fixtureHtmlWithoutAds() {
  const html = fixtureHtml();
  const marker = "window.__APOLLO_STATE__=";
  const start = html.indexOf(marker) + marker.length;
  const end = html.indexOf(";</script>", start);
  const state = JSON.parse(html.slice(start, end));
  for (const key of Object.keys(state.ROOT_QUERY)) {
    if (key.startsWith("adBusinesses(")) delete state.ROOT_QUERY[key];
  }
  return `<html><script>${marker}${JSON.stringify(state)};</script></html>`;
}

function job(runId, mode = "offline") {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    mode,
    keyword: KEYWORD,
    timeoutMs: 25000,
    responseSizeLimitBytes: 2097152
  };
}

function bytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fixtureFetch(counter, html = fixtureHtml()) {
  return async (url, init) => {
    counter.calls += 1;
    counter.url = String(url);
    counter.init = init;
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
}

async function expectCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof V2BasicPlaceError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, false);
    return true;
  });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-basic-place-test-"));
  try {
    const counter = { calls: 0 };
    const offlineBytes = bytes(job("offline-basic-success-001"));
    const result = await executeBasicPlaceJob({
      jobBytes: offlineBytes,
      outputRoot: root,
      env: {},
      fetchImpl: fixtureFetch(counter)
    });
    assert.equal(counter.calls, 1);
    assert.match(counter.url, /^https:\/\/pcmap\.place\.naver\.com\/accommodation\/list\?query=/u);
    assert.equal(counter.init.method, "GET");
    assert.equal(counter.init.redirect, "manual");
    assert.equal(result.organicRows, 2);
    assert.equal(result.advertisementRows, 2);
    assert.equal(result.adDiagnosticStatus, "current-filter-matched-with-items");
    assert.equal(result.adCandidateCount, 1);
    assert.equal(result.adMatchedCandidateCount, 1);
    assert.match(result.providerResponseDigest, /^[a-f0-9]{64}$/u);
    assert.match(result.diagnosticsDigest, /^[a-f0-9]{64}$/u);
    assert.equal(result.externalRequests, 0);
    assert.equal(result.fixtureRequests, 1);
    assert.equal(result.operationalWrites, 0);
    assert.equal(result.rawProviderResponseStored, false);

    const finalRoot = path.join(root, "offline-basic-success-001");
    const organic = JSON.parse(await fs.readFile(path.join(finalRoot, "organic.json"), "utf8"));
    const ads = JSON.parse(await fs.readFile(path.join(finalRoot, "advertisements.json"), "utf8"));
    const diagnostics = JSON.parse(await fs.readFile(path.join(finalRoot, "provider-diagnostics.json"), "utf8"));
    const manifest = JSON.parse(await fs.readFile(path.join(finalRoot, "manifest.json"), "utf8"));
    assert.deepEqual(organic.map((row) => row.placeId), ["35644668", "200"]);
    assert.deepEqual(organic.map((row) => row.rank), [1, 2]);
    assert.deepEqual(ads.map((row) => row.placeId), ["35644668", "300"]);
    assert.deepEqual(ads.map((row) => row.adOrder), [1, 2]);
    assert.equal(organic[0].address, "경상남도 산청군 fixture-road");
    assert.equal(organic[0].roomPreviewCount, 1);
    assert.equal(organic[0].minimumPrice, 120000);
    assert.equal(manifest.counts.adContractPresent, true);
    assert.equal(manifest.diagnostics.status, "current-filter-matched-with-items");
    assert.equal(manifest.diagnostics.sha256, result.diagnosticsDigest);
    assert.equal(diagnostics.advertisement.candidateCount, 1);
    assert.equal(diagnostics.advertisement.matchedCandidateCount, 1);
    assert.equal(diagnostics.advertisement.matchedDirectItemCount, 2);
    assert.equal(diagnostics.response.rawProviderResponseStored, false);
    assert.equal(manifest.contracts.rawProviderResponseStored, false);
    assert.equal(manifest.contracts.operationalWrites, 0);
    const allArtifacts = (await Promise.all((await fs.readdir(finalRoot)).map((name) => fs.readFile(path.join(finalRoot, name), "utf8")))).join("\n");
    assert.doesNotMatch(allArtifacts, /__APOLLO_STATE__|set-cookie\s*:|authorization\s*:|fixture-secret-value/iu);

    const noAdsCounter = { calls: 0 };
    const noAdsBytes = bytes(job("offline-basic-no-ads-001"));
    const noAdsResult = await executeBasicPlaceJob({
      jobBytes: noAdsBytes,
      outputRoot: root,
      env: {},
      fetchImpl: fixtureFetch(noAdsCounter, fixtureHtmlWithoutAds())
    });
    assert.equal(noAdsCounter.calls, 1);
    assert.equal(noAdsResult.organicRows, 2);
    assert.equal(noAdsResult.advertisementRows, 0);
    assert.equal(noAdsResult.adDiagnosticStatus, "ad-operation-absent");
    assert.equal(noAdsResult.adCandidateCount, 0);
    const noAdsDiagnostics = JSON.parse(await fs.readFile(path.join(root, "offline-basic-no-ads-001", "provider-diagnostics.json"), "utf8"));
    assert.equal(noAdsDiagnostics.status, "ad-operation-absent");

    await expectCode(() => executeBasicPlaceJob({
      jobBytes: offlineBytes,
      outputRoot: root,
      env: {},
      fetchImpl: fixtureFetch({ calls: 0 })
    }), "V2_BASIC_PLACE_DUPLICATE_RUN");

    let blockedCalls = 0;
    const liveBytes = bytes(job("live-gate-blocked-001", "live"));
    await expectCode(() => executeBasicPlaceJob({
      jobBytes: liveBytes,
      outputRoot: root,
      env: {},
      fetchImpl: async () => { blockedCalls += 1; }
    }), "V2_BASIC_PLACE_LIVE_GATE_BLOCKED");
    assert.equal(blockedCalls, 0);

    const liveCounter = { calls: 0 };
    const liveResult = await executeBasicPlaceJob({
      jobBytes: liveBytes,
      outputRoot: root,
      env: {
        [LIVE_ENV_NAMES.approved]: APPROVAL_TOKEN,
        [LIVE_ENV_NAMES.approvedJobDigest]: sha256(liveBytes),
        [LIVE_ENV_NAMES.requestBudget]: "1",
        [LIVE_ENV_NAMES.automaticRetry]: "0",
        [LIVE_ENV_NAMES.fallback]: "0",
        [LIVE_ENV_NAMES.operationalWrites]: "0"
      },
      fetchImpl: fixtureFetch(liveCounter)
    });
    assert.equal(liveCounter.calls, 1);
    assert.equal(liveResult.externalRequests, 1);

    const invalidBytes = bytes({ ...job("invalid-path-001"), runId: "../outside" });
    await expectCode(() => executeBasicPlaceJob({
      jobBytes: invalidBytes,
      outputRoot: root,
      env: {},
      fetchImpl: fixtureFetch({ calls: 0 })
    }), "V2_BASIC_PLACE_JOB_INVALID");

    const missingStateBytes = bytes(job("offline-missing-state-001"));
    await expectCode(() => executeBasicPlaceJob({
      jobBytes: missingStateBytes,
      outputRoot: root,
      env: {},
      fetchImpl: fixtureFetch({ calls: 0 }, "<html>missing</html>")
    }), "V2_BASIC_PLACE_APOLLO_UNAVAILABLE");
    await assert.rejects(fs.access(path.join(root, "offline-missing-state-001")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({ event: "v2_live_basic_place_tests_complete", assertions: 58, externalRequests: 0, operationalWrites: 0 })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
