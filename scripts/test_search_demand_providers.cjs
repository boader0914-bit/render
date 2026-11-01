"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSearchDemandProviders } = require("./lib/search_demand_providers.cjs");
const KEYS = { searchadApiKey: "DUMMY-AD-ID", searchadSecretKey: "DUMMY-AD-SECRET", searchadCustomerId: "DUMMY-AD-CUSTOMER",
  datalabProvider: "ncp_apihub", ncpApihubClientId: "DUMMY-NCP-ID", ncpApihubClientSecret: "DUMMY-NCP-SECRET",
  naverClientId: "DUMMY-LEGACY-ID", naverClientSecret: "DUMMY-LEGACY-SECRET" };
const response = data => new Response(JSON.stringify(data), { status: 200 });
const adPayload = (keyword = "경남글램핑") => ({ keywordList: [{ relKeyword: keyword, monthlyPcQcCnt: 1790, monthlyMobileQcCnt: 7870, compIdx: "높음" }] });
function trendPayload(body) {
  const data = [];
  for (let month = new Date(body.startDate + "T00:00:00Z"); month.toISOString().slice(0, 10) <= body.endDate; month.setUTCMonth(month.getUTCMonth() + 1)) {
    data.push({ period: month.toISOString().slice(0, 10), ratio: 0 });
  }
  return { ...body, results: [{ title: body.keywordGroups[0].groupName, keywords: body.keywordGroups[0].keywords, data }] };
}
function fixture(overrides = {}) {
  const state = { time: Date.parse("2026-11-01T07:20:51.000Z"), keys: { ...KEYS }, calls: [], waits: [] };
  const providers = createSearchDemandProviders({ readKeys: async () => state.keys, clock: () => state.time,
    waitImpl: async ms => { state.waits.push(ms); state.time += ms; }, fetchImpl: async (url, options) => {
      state.calls.push({ url, options, at: state.time });
      return url.includes("searchad") ? response(adPayload()) : response(trendPayload(JSON.parse(options.body)));
    }, ...overrides });
  return { state, providers };
}

test("exact keyword request performs one call and returns normalized safe data without keys or provider bodies", async () => {
  const f = fixture(), result = await f.providers.searchad({ keyword: "경남글램핑" });
  assert.equal(result.status, "complete"); assert.equal(result.httpStatus, 200); assert.equal(result.requestCount, 1);
  assert.equal(f.state.calls.length, 1); assert.equal(result.snapshot.provider, "searchad");
  assert.equal(new URL(f.state.calls[0].url).searchParams.get("hintKeywords"), "경남글램핑");
  assert.equal(f.state.calls[0].options.redirect, "error"); assert.equal(f.state.calls[0].options.method, "GET");
  for (const value of Object.values(KEYS).filter(value => value !== "ncp_apihub")) assert.equal(JSON.stringify(result).includes(value), false);
  assert.equal(JSON.stringify(f.providers.status()).includes("sdscope_"), false);
});

test("all related response rows remain available for normalization beyond the previous20-row cap", async () => {
  const rows = [...adPayload().keywordList, ...Array.from({ length: 35 }, (_, index) => ({ relKeyword: `관련어${index}`, monthlyPcQcCnt: "<10", monthlyMobileQcCnt: 10 }))];
  const f = fixture({ fetchImpl: async () => response({ keywordList: rows, PRIVATE_BODY: "DO_NOT_STORE" }) });
  const result = await f.providers.searchad({ keyword: "경남글램핑" });
  assert.equal(result.status, "complete"); assert.equal(result.snapshot.rows.length, 36);
  assert.equal(JSON.stringify(result).includes("DO_NOT_STORE"), false);
});

test("missing exact anchor never substitutes a related keyword", async () => {
  const f = fixture({ fetchImpl: async () => response(adPayload("다른글램핑")) });
  const result = await f.providers.searchad({ keyword: "경남글램핑" });
  assert.equal(result.status, "held"); assert.equal(result.errorCode, "NO_EXACT_KEYWORD");
  assert.equal(result.snapshot.status, "missing");
});

test("range counts stay ranges and a present but partial anchor is not mislabeled missing", async () => {
  const ranges = fixture({ fetchImpl: async () => response({ keywordList: [{ relKeyword: "경남글램핑", monthlyPcQcCnt: "<10", monthlyMobileQcCnt: 0 }] }) });
  const range = await ranges.providers.searchad({ keyword: "경남글램핑" });
  assert.equal(range.status, "complete"); assert.equal(range.snapshot.anchor.monthlyPc.state, "range"); assert.equal(range.snapshot.anchor.monthlyPc.value, null);
  const partial = fixture({ fetchImpl: async () => response({ keywordList: [{ relKeyword: "경남글램핑", monthlyPcQcCnt: null, monthlyMobileQcCnt: 1 }] }) });
  assert.equal((await partial.providers.searchad({ keyword: "경남글램핑" })).errorCode, "INCOMPLETE_DATA");
});

test("one host is serialized with350ms starts while different hosts keep independent lanes", async () => {
  const f = fixture();
  await Promise.all([f.providers.searchad({ keyword: "경남글램핑" }), f.providers.searchad({ keyword: "경남글램핑" })]);
  assert.equal(f.state.calls.length, 2); assert.ok(f.state.calls[1].at - f.state.calls[0].at >= 350);
  await f.providers.datalab({ keyword: "경남글램핑", startDate: "2025-11-01", endDate: "2026-10-31" });
  assert.equal(f.state.waits.length, 1, "the NCP host does not wait on SearchAd's lane");
});

test("API HUB uses only the explicit selected pair and one complete12-month request", async () => {
  const f = fixture(), result = await f.providers.datalab({ keyword: "경남글램핑", startDate: "2025-11-01", endDate: "2026-10-31" });
  assert.equal(result.status, "complete"); assert.equal(result.snapshot.series.length, 12);
  const call = f.state.calls[0]; assert.equal(call.url, "https://naverapihub.apigw.ntruss.com/search-trend/v1/search");
  assert.deepEqual(call.options.headers, { "Content-Type": "application/json", "X-NCP-APIGW-API-KEY-ID": KEYS.ncpApihubClientId, "X-NCP-APIGW-API-KEY": KEYS.ncpApihubClientSecret });
  assert.equal(result.snapshot.connectionProvider, "ncp_apihub");
  f.state.keys.ncpApihubClientSecret = "";
  assert.equal((await f.providers.datalab({ keyword: "경남글램핑", startDate: "2025-11-01", endDate: "2026-10-31" })).errorCode, "MISSING_KEY");
  assert.equal(f.state.calls.length, 1, "legacy credentials cannot fill the missing NCP pair");
});

test("credential scope changes fail before dispatch and never mix keys", async () => {
  const f = fixture(), scope = await f.providers.credentialScope("searchad");
  f.state.keys.searchadSecretKey = "CHANGED-DUMMY";
  const result = await f.providers.searchad({ keyword: "경남글램핑", scopeId: scope.scopeId });
  assert.equal(result.status, "held"); assert.equal(result.errorCode, "CREDENTIAL_SCOPE_CHANGED"); assert.equal(f.state.calls.length, 0);
});

test("authentication and429 are protected results with no retry or response-body retention", async () => {
  for (const status of [401, 403, 429]) {
    let calls = 0;
    const f = fixture({ fetchImpl: async () => { calls++; return new Response("PRIVATE-PROVIDER-ERROR", { status }); } });
    const result = await f.providers.searchad({ keyword: "경남글램핑" });
    assert.equal(result.status, "blocked"); assert.equal(result.errorCode, status === 429 ? "QUOTA_EXCEEDED" : "AUTH_ERROR");
    assert.equal(calls, 1); assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  }
});

test("malformed bodies, schema failures and mismatched periods never become successful HTTP200 data", async () => {
  const cases = [[() => new Response("not json"), "INVALID_JSON"], [() => response({ keywordList: "wrong" }), "INVALID_RESPONSE"]];
  for (const [fetchImpl, code] of cases) {
    const result = await fixture({ fetchImpl }).providers.searchad({ keyword: "경남글램핑" });
    assert.equal(result.status, "failed"); assert.equal(result.errorCode, code);
  }
  const result = await fixture({ fetchImpl: async () => response({ startDate: "2020-01-01", endDate: "2020-12-31", timeUnit: "month", results: [] }) })
    .providers.datalab({ keyword: "경남글램핑", startDate: "2025-11-01", endDate: "2026-10-31" });
  assert.equal(result.errorCode, "PERIOD_MISMATCH");
  const mismatch = await fixture({ fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body), payload = trendPayload(body); payload.results[0].keywords = ["가평글램핑"]; return response(payload);
  } }).providers.datalab({ keyword: "경남글램핑", startDate: "2025-11-01", endDate: "2026-10-31" });
  assert.equal(mismatch.errorCode, "KEYWORD_MISMATCH");
});

test("response byte bounds and timeout cover the full response body with one attempted call", async () => {
  const large = fixture({ maxResponseBytes: { searchad: 50 }, fetchImpl: async () => response(adPayload()) });
  assert.equal((await large.providers.searchad({ keyword: "경남글램핑" })).errorCode, "RESPONSE_TOO_LARGE");
  let calls = 0;
  const slow = fixture({ timeoutMs: 10, fetchImpl: async () => { calls++; return { status: 200, text: () => new Promise(() => {}) }; } });
  const result = await slow.providers.searchad({ keyword: "경남글램핑" });
  assert.equal(result.errorCode, "TIMEOUT"); assert.equal(calls, 1);
  assert.throws(() => fixture({ minIntervalMs: 349 }), TypeError);
  assert.throws(() => fixture({ maxResponseBytes: { searchad: 2097153 } }), TypeError);
});
