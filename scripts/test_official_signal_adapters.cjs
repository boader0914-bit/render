"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  createNaverSearchAdAdapter,
  createNaverTrendAdapter,
  createTourismAdapter
} = require("./integration/services/official_signal_adapters.cjs");

const CLOCK = () => Date.parse("2026-07-30T01:02:03.000Z");
const INPUT = Object.freeze({
  companyId: "cmp_live_official_001",
  tenantCompanyId: "tenant_live_official_001",
  region: "경상남도 창녕군",
  periodMonth: "2026-07",
  runId: "signal_job_official_001",
  timeoutMs: 1000
});

async function trendContract() {
  const requests = [];
  const adapter = createNaverTrendAdapter({
    clientId: "client-id-value",
    clientSecret: "client-secret-value",
    clock: CLOCK,
    transport: async (request) => {
      requests.push(request);
      return {
        status: 200,
        headers: { "x-transaction-id": "provider-transaction-001" },
        body: { results: [{ data: [{ period: "2026-07-01", ratio: 25 }, { period: "2026-07-02", ratio: 75 }] }] }
      };
    }
  });
  const result = await adapter.collect(INPUT);
  assert.equal(result.externalNetworkCalls, 1);
  assert.equal(result.signals[0].kind, "trend.index");
  assert.equal(result.signals[0].index, 50);
  assert.equal(result.signals[0].synthetic, false);
  assert.equal(result.signals[0].dataMode, "live");
  assert.equal(result.signals[0].sourceUrl, "https://openapi.naver.com/v1/datalab/search");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://openapi.naver.com/v1/datalab/search");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers["X-Naver-Client-Id"], "client-id-value");
  assert.equal(requests[0].headers["X-Naver-Client-Secret"], "client-secret-value");
  const body = JSON.parse(requests[0].body);
  assert.deepEqual(Object.keys(body).sort(), ["endDate", "keywordGroups", "startDate", "timeUnit"]);
  assert.equal(JSON.stringify(result).includes("client-secret-value"), false);

  const limited = createNaverTrendAdapter({
    clientId: "id",
    clientSecret: "do-not-leak-429",
    transport: async () => ({ status: 429, body: { message: "secret echoed?" } })
  });
  await assert.rejects(limited.collect(INPUT), (error) => {
    assert.equal(error.category, "429");
    assert.equal(error.externalNetworkCalls, 1);
    assert.equal(String(error.stack).includes("do-not-leak-429"), false);
    return true;
  });
  const transportLeak = createNaverTrendAdapter({
    clientId: "id",
    clientSecret: "credential-must-never-surface",
    transport: async () => { throw new Error("transport echoed credential-must-never-surface"); }
  });
  await assert.rejects(transportLeak.collect(INPUT), (error) => {
    assert.equal(error.code, "SIGNAL_PROVIDER_TRANSPORT");
    assert.equal(String(error.stack).includes("credential-must-never-surface"), false);
    assert.equal(error.externalNetworkCalls, 1);
    return true;
  });
}

async function tourismContract() {
  const requests = [];
  const responses = [
    { response: { header: { resultCode: "00" }, body: { items: { item: [
      { areaNm: "경상남도", touNum: "400" }, { areaNm: "서울특별시", touNum: "800" }
    ] } } } },
    { response: { header: { resultCode: "00" }, body: { items: { item: [
      { areaCd: "36", tarSvcDemIxVal: "62" }, { areaCd: "36", tarSvcDemIxVal: "78" }
    ] } } } },
    { response: { header: { resultCode: "00" }, body: { items: { item: [
      { areaCd: "36", touDivIxVal: "70" }, { areaCd: "36", touDivIxVal: "90" }
    ] } } } }
  ];
  const adapter = createTourismAdapter({
    serviceKey: "tour-api-service-key",
    clock: CLOCK,
    transport: async (request) => {
      requests.push(request);
      return { status: 200, body: responses[requests.length - 1] };
    }
  });
  const result = await adapter.collect({ ...INPUT, signalKinds: ["tourism.visitors", "tourism.resource-demand", "tourism.diversity"] });
  assert.equal(result.externalNetworkCalls, 3);
  assert.deepEqual(result.signals.map((row) => [row.kind, row.index]), [
    ["tourism.visitors", 50], ["tourism.resource-demand", 70], ["tourism.diversity", 80]
  ]);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    "/B551011/DataLabService/metcoRegnVisitrDDList",
    "/B551011/AreaTarResDemService/areaTarSvcDemList",
    "/B551011/AreaTarDivService/areaTouDivList"
  ]);
  assert.equal(requests.every((request) => new URL(request.url).protocol === "https:"), true);
  assert.equal(requests.every((request) => new URL(request.url).searchParams.get("serviceKey") === "tour-api-service-key"), true);
  assert.equal(JSON.stringify(result).includes("tour-api-service-key"), false);
  assert.equal(result.signals.every((row) => !row.sourceUrl.includes("?")), true);
}

async function searchAdContract() {
  const requests = [];
  const adapter = createNaverSearchAdAdapter({
    apiKey: "search-ad-api-key",
    secretKey: "search-ad-secret-key",
    customerId: "1234567",
    clock: CLOCK,
    transport: async (request) => {
      requests.push(request);
      return { status: 200, body: { keywordList: [
        { relKeyword: "경상남도창녕군숙박", monthlyPcQcCnt: 120, monthlyMobileQcCnt: 280 },
        { relKeyword: "다른숙박", monthlyPcQcCnt: 400, monthlyMobileQcCnt: 400 }
      ] } };
    }
  });
  const result = await adapter.collect(INPUT);
  assert.equal(result.signals[0].kind, "search.volume");
  assert.equal(result.signals[0].index, 50);
  const request = requests[0];
  const expected = crypto.createHmac("sha256", "search-ad-secret-key")
    .update(`${CLOCK()}.GET./keywordstool`).digest("base64");
  assert.equal(request.headers["X-Signature"], expected);
  assert.equal(new URL(request.url).origin, "https://api.searchad.naver.com");
  assert.equal(new URL(request.url).pathname, "/keywordstool");
  assert.equal(JSON.stringify(result).includes("search-ad-secret-key"), false);
}

async function failClosedCredentials() {
  assert.throws(
    () => createNaverTrendAdapter({ clientId: "id", clientSecret: "", transport: async () => ({ status: 200 }) }),
    (error) => error.code === "SIGNAL_CONNECTOR_CREDENTIAL_REQUIRED" && error.externalNetworkCalls === 0
  );
  assert.throws(
    () => createTourismAdapter({ serviceKey: "key", transport: null }),
    (error) => error.code === "SIGNAL_CONNECTOR_TRANSPORT_DISABLED" && error.externalNetworkCalls === 0
  );
}

async function main() {
  await trendContract();
  await tourismContract();
  await searchAdContract();
  await failClosedCredentials();
  console.log("Stage 231 official signal adapter allowlist, schema, credentials and injected-transport tests passed; actual network calls: 0");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
