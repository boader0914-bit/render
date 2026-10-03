"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createRegionalSearchTrendService } = require("./lib/regional_search_trends.cjs");

const query = { regionKey: "kr_gyeongnam_sancheong", month: "2026-08" };
const region = (key) => ({ regionKey: key, name: key === "kr_gyeongnam_sancheong" ? "산청군" : "포천시", shortName: "산청", active: true, selectable: true, level: "local" });

test("24-month comparisons use one normalization window and cannot overwrite the existing 12-month cache", async t => {
  const f=await fixture(t);
  const original=await f.service.refresh(query);
  const extended=await f.service.refresh({...query,months:24});
  assert.equal(extended.startDate,'2024-09-01');assert.equal(extended.endDate,'2026-08-31');
  assert.equal(extended.series.length,24);assert.equal(f.calls.length,2);
  assert.deepEqual((await f.service.get(query)).series,original.series);
  assert.deepEqual((await f.service.get({...query,months:24})).series,extended.series);
  assert.equal(f.calls.length,2);
  await assert.rejects(f.service.refresh({...query,months:13}),e=>e.statusCode===400);
});
function payload(body, value = 0) {
  const rows = [];
  for (let cursor = new Date(body.startDate + "T12:00:00Z"); cursor.toISOString().slice(0, 10) <= body.endDate; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
    rows.push({ period: cursor.toISOString().slice(0, 10), ratio: value });
  }
  return { startDate: body.startDate, endDate: body.endDate, timeUnit: "month", results: [{ title: body.keywordGroups[0].groupName, keywords: body.keywordGroups[0].keywords, data: rows }] };
}
async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "regional-search-trends-"));
  const prefix = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(path.resolve(dataDir).startsWith(prefix));
  t.after(async () => { assert.ok(path.resolve(dataDir).startsWith(prefix)); await fs.rm(dataDir, { recursive: true, force: true }); });
  let current = new Date("2026-09-27T01:00:00.000Z"), impl;
  const calls = [];
  impl = async (_url, options) => new Response(JSON.stringify(payload(JSON.parse(options.body))), { status: 200 });
  const options = { dataDir, readTrafficKeys: async () => ({ naverClientId: "CLIENT-TEST-ONLY", naverClientSecret: "SECRET-DO-NOT-STORE" }),
    resolveRegion: async (key) => region(key), now: () => current, timeoutMs: 200,
    fetchImpl: async (url, request) => { calls.push({ url, body: JSON.parse(request.body) }); return impl(url, request); }, ...overrides };
  return { dataDir, options, calls, service: createRegionalSearchTrendService(options), setTime: (time) => { current = new Date(time); }, setFetch: (fn) => { impl = fn; } };
}

test("exact regional keyword and selected 12-month window are stored with observed zero; GET and status never fetch", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.get(query)).status, "missing");
  assert.equal((await f.service.status()).configured, true);
  assert.equal(f.calls.length, 0);
  const result = await f.service.refresh(query);
  assert.equal(result.status, "ready"); assert.equal(result.keyword, "산청글램핑");
  assert.equal(result.startDate, "2025-09-01"); assert.equal(result.endDate, "2026-08-31"); assert.equal(result.timeUnit, "month");
  assert.equal(result.series.length, 12); assert.equal(result.series.every((point) => point.status === "observed" && point.ratio === 0 && point.value === 0), true);
  assert.equal(result.networkAttempted, true); assert.equal(result.partialMonth, false);
  assert.equal(f.calls[0].url, "https://openapi.naver.com/v1/datalab/search");
  assert.deepEqual(f.calls[0].body.keywordGroups, [{ groupName: "산청글램핑", keywords: ["산청글램핑"] }]);
  const cached = await f.service.get(query);
  assert.equal(cached.cacheReused, true); assert.equal(cached.networkAttempted, false);
  assert.equal((await f.service.status()).lastSuccessAt, result.retrievedAt);
  assert.equal(f.calls.length, 1);
  const reloaded = createRegionalSearchTrendService(f.options);
  assert.equal((await reloaded.get(query)).status, "ready");
  assert.equal(f.calls.length, 1);
});

test("current month uses yesterday in Korea and reuses a fully observed partial-month cache within 24h", async (t) => {
  const f = await fixture(t);
  f.setTime("2026-09-26T15:30:00.000Z");
  const current = { ...query, month: "2026-09" };
  const result = await f.service.refresh(current);
  assert.equal(result.partialMonth, true); assert.equal(result.status, "partial"); assert.equal(result.errorCode, "");
  assert.equal(result.endDate, "2026-09-26"); assert.equal(result.startDate, "2025-10-01");
  assert.equal(result.series.at(-1).period, "2026-09-01");
  assert.equal((await f.service.refresh(current)).cacheReused, true);
  assert.equal(f.calls.length, 1);
  f.setTime("2026-09-27T15:10:00.000Z");
  assert.equal((await f.service.get(current)).status, "missing", "next Korea day is a different exact request window");
  await f.service.refresh(current);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].body.endDate, "2026-09-27");
});

test("the first Korea day of a month is publication pending without provider calls", async (t) => {
  const f = await fixture(t);
  f.setTime("2026-09-30T15:01:00.000Z");
  const current = { ...query, month: "2026-10" };
  const result = await f.service.refresh(current);
  assert.equal(result.status, "publication_pending"); assert.equal(result.errorCode, "PUBLICATION_PENDING");
  assert.equal(result.endDate, "2026-09-30"); assert.equal(result.series.at(-1).period, "2026-10-01");
  assert.equal(result.series.at(-1).status, "missing"); assert.equal(result.networkAttempted, false);
  assert.equal((await f.service.get(current)).status, "publication_pending");
  assert.equal(f.calls.length, 0);
});

test("early supported months start in 2016 while invalid input and unsupported regions fail before fetch", async (t) => {
  const f = await fixture(t);
  const early = await f.service.refresh({ ...query, month: "2016-01" });
  assert.equal(early.startDate, "2016-01-01"); assert.equal(early.endDate, "2016-01-31"); assert.equal(early.series.length, 1);
  for (const input of [{ ...query, month: "2015-12" }, { ...query, month: "2026-10" }, { ...query, month: "2026-13" },
    { ...query, month: "2026-8" }, { ...query, regionKey: "../path" }, { ...query, keywords: ["override"] }]) {
    await assert.rejects(f.service.refresh(input), (error) => error.statusCode === 400);
  }
  for (const patch of [{ level: "broad" }, { active: false }, { selectable: false }, { regionKey: "different" }, { active: undefined }]) {
    const other = createRegionalSearchTrendService({ ...f.options, resolveRegion: async (key) => ({ ...region(key), ...patch }) });
    await assert.rejects(other.refresh(query), (error) => error.code === "INVALID_REGION");
  }
  assert.equal(f.calls.length, 1);
});

test("multiword local names keep their identity and region/month/keyword caches do not fall back globally", async (t) => {
  const f = await fixture(t, { resolveRegion: async (key) => ({ ...region(key), name: "수원시 장안구" }) });
  assert.equal((await f.service.refresh(query)).keyword, "수원시장안구글램핑");
  const originalNames = createRegionalSearchTrendService({ ...f.options, resolveRegion: async (key) => region(key) });
  assert.equal((await originalNames.get(query)).status, "missing", "a changed keyword must not reuse the old name's normalization window");
  await originalNames.refresh(query);
  assert.equal((await originalNames.get({ ...query, month: "2026-07" })).status, "missing");
  assert.equal((await originalNames.get({ ...query, regionKey: "kr_gyeonggi_pocheon" })).status, "missing");
  assert.equal(f.calls.length, 2);
});

test("canonical regional keywords disambiguate local names and gu names retain their parent", async (t) => {
  const f = await fixture(t);
  const cases = [
    [{ name: "고성군", searchTrendKeyword: "경남고성글램핑" }, "경남고성글램핑"],
    [{ name: "고성군", searchTrendKeyword: "강원고성글램핑" }, "강원고성글램핑"],
    [{ name: "광주시", searchTrendKeyword: "경기광주글램핑" }, "경기광주글램핑"],
    [{ name: "중구", fullName: "서울특별시 중구", searchTrendKeyword: "서울중구글램핑" }, "서울중구글램핑"],
    [{ name: "중구", fullName: "서울특별시 중구" }, "서울특별시중구글램핑"],
    [{ name: "북구", fullName: "부산광역시 북구" }, "부산광역시북구글램핑"]
  ];
  for (const [metadata, keyword] of cases) {
    const service = createRegionalSearchTrendService({ ...f.options, resolveRegion: async (key) => ({ ...region(key), ...metadata }) });
    assert.equal((await service.get(query)).status, "missing", "a different canonical keyword must have a separate cache");
    const result = await service.refresh(query);
    assert.equal(result.keyword, keyword);
    assert.deepEqual(f.calls.at(-1).body.keywordGroups, [{ groupName: keyword, keywords: [keyword] }]);
  }
  for (const searchTrendKeyword of ["", " 서울중구글램핑", ["서울중구글램핑"], "서울중구", null]) {
    const service = createRegionalSearchTrendService({ ...f.options, resolveRegion: async (key) => ({ ...region(key), searchTrendKeyword }) });
    await assert.rejects(service.refresh(query), (error) => error.code === "INVALID_REGION");
  }
  assert.equal(f.calls.length, cases.length);
});

test("missing and null month points remain missing; blanks are not coerced to zero", async (t) => {
  const f = await fixture(t);
  f.setFetch(async (_url, options) => {
    const result = payload(JSON.parse(options.body)); result.results[0].data.splice(2, 1); result.results[0].data[0].ratio = null;
    return new Response(JSON.stringify(result));
  });
  const result = await f.service.refresh(query);
  assert.equal(result.status, "partial"); assert.equal(result.errorCode, "MISSING_VALUES");
  assert.equal(result.series[0].status, "missing"); assert.equal(result.series[0].ratio, null);
  assert.equal(result.series[2].status, "missing"); assert.equal(result.series[1].status, "observed"); assert.equal(result.series[1].ratio, 0);
  assert.equal((await f.service.get(query)).series[0].value, null);
  f.setFetch(async (_url, options) => { const result = payload(JSON.parse(options.body)); result.results[0].data[0].ratio = " 0 "; return new Response(JSON.stringify(result)); });
  const invalid = await f.service.refresh(query);
  assert.equal(invalid.status, "partial", "keep the preceding valid partial snapshot"); assert.equal(invalid.errorCode, "INVALID_RESPONSE");
  assert.equal(invalid.cacheReused, true); assert.equal(invalid.series[0].ratio, null);
});

test("official decimal-string ratios are accepted while empty, nondecimal and boolean values are rejected", async (t) => {
  const f = await fixture(t);
  f.setFetch(async (_url, options) => {
    const result = payload(JSON.parse(options.body), "12.34567");
    result.results[0].data[0].ratio = "0"; result.results[0].data[1].ratio = "100.00000";
    return new Response(JSON.stringify(result));
  });
  const valid = await f.service.refresh(query);
  assert.equal(valid.status, "ready"); assert.equal(valid.series[0].ratio, 0);
  assert.equal(valid.series[1].ratio, 100); assert.equal(valid.series[2].ratio, 12.34567);
  f.setTime("2026-09-29T01:00:00.000Z");
  for (const ratio of ["", " ", " 0", "0 ", true, false, "1e2", "0x10", "Infinity", "NaN", "-1", "100.01"]) {
    f.setFetch(async (_url, options) => { const result = payload(JSON.parse(options.body)); result.results[0].data[0].ratio = ratio; return new Response(JSON.stringify(result)); });
    const result = await f.service.refresh(query);
    assert.equal(result.errorCode, "INVALID_RESPONSE"); assert.equal(result.cacheReused, true);
    assert.deepEqual(result.series, valid.series);
  }
});

test("a current-month response with a missing target point is partial data, not a verified complete connection result", async (t) => {
  const f = await fixture(t);
  f.setFetch(async (_url, options) => { const result = payload(JSON.parse(options.body)); result.results[0].data.pop(); return new Response(JSON.stringify(result)); });
  const result = await f.service.refresh({ ...query, month: "2026-09" });
  assert.equal(result.partialMonth, true); assert.equal(result.status, "partial"); assert.equal(result.errorCode, "MISSING_VALUES");
  assert.equal(result.series.at(-1).status, "missing"); assert.equal(result.networkAttempted, true);
  const status = await f.service.status();
  assert.equal(status.lastSuccessAt, ""); assert.equal(status.lastCheckedAt, result.retrievedAt); assert.equal(status.errorCode, "MISSING_VALUES");
});

test("identity, duplicate periods, bounds and response windows are strictly validated", async (t) => {
  const f = await fixture(t);
  const cases = [
    ["KEYWORD_MISMATCH", (data) => { data.results[0].title = "다른글램핑"; }],
    ["KEYWORD_MISMATCH", (data) => { data.results[0].keywords.push("다른키워드"); }],
    ["PERIOD_MISMATCH", (data) => { data.endDate = "2026-07-31"; }],
    ["PERIOD_MISMATCH", (data) => { data.results[0].data[1].period = data.results[0].data[0].period; }],
    ["PERIOD_MISMATCH", (data) => { data.results[0].data[0].period = "2025-09-02"; }],
    ["INVALID_RESPONSE", (data) => { data.results[0].data[0].ratio = -1; }],
    ["INVALID_RESPONSE", (data) => { data.results[0].data[0].ratio = 100.1; }],
    ["INVALID_RESPONSE", (data) => { data.results.push(data.results[0]); }]
  ];
  for (const [code, mutate] of cases) {
    f.setFetch(async (_url, options) => { const data = payload(JSON.parse(options.body)); mutate(data); return new Response(JSON.stringify(data)); });
    const result = await f.service.refresh(query);
    assert.equal(result.status, "failed"); assert.equal(result.errorCode, code); assert.equal(result.series.every((point) => point.ratio === null), true);
  }
  assert.equal(f.calls.length, cases.length);
});

test("an empty successful response is missing, never a zero-valued successful trend", async (t) => {
  const f = await fixture(t);
  f.setFetch(async (_url, options) => { const data = payload(JSON.parse(options.body)); data.results[0].data = []; return new Response(JSON.stringify(data)); });
  const result = await f.service.refresh(query);
  assert.equal(result.status, "missing"); assert.equal(result.errorCode, "NO_DATA");
  assert.equal(result.series.every((point) => point.status === "missing" && point.ratio === null), true);
  assert.equal((await f.service.status()).lastSuccessAt, "");
});

test("429 never retries and preserves the previous valid cache and its real timestamp", async (t) => {
  const f = await fixture(t);
  const old = await f.service.refresh(query);
  f.setTime("2026-09-29T01:00:00.000Z");
  f.setFetch(async () => new Response("secret body", { status: 429 }));
  const failed = await f.service.refresh(query);
  assert.equal(f.calls.length, 2); assert.equal(failed.status, "partial"); assert.equal(failed.errorCode, "QUOTA_EXCEEDED");
  assert.equal(failed.cacheReused, true); assert.equal(failed.retrievedAt, old.retrievedAt); assert.deepEqual(failed.series, old.series);
  const cached = await f.service.get(query);
  assert.equal(cached.errorCode, "QUOTA_EXCEEDED"); assert.equal(cached.retrievedAt, old.retrievedAt); assert.equal(cached.networkAttempted, false);
  const status = await f.service.status();
  assert.equal(status.lastSuccessAt, old.retrievedAt); assert.equal(status.lastCheckedAt, "2026-09-29T01:00:00.000Z"); assert.equal(status.errorCode, "QUOTA_EXCEEDED");
});

test("a partial refresh cannot replace an older complete normalization window", async (t) => {
  const f = await fixture(t);
  const old = await f.service.refresh(query); f.setTime("2026-09-29T01:00:00.000Z");
  f.setFetch(async (_url, options) => { const data = payload(JSON.parse(options.body), 90); data.results[0].data.pop(); return new Response(JSON.stringify(data)); });
  const result = await f.service.refresh(query);
  assert.equal(result.status, "partial"); assert.equal(result.errorCode, "MISSING_VALUES"); assert.equal(result.cacheReused, true);
  assert.deepEqual(result.series, old.series, "do not merge independently normalized partial responses");
  assert.deepEqual((await f.service.get(query)).series, old.series);
});

test("fresh historical cache reuses for 24h and simultaneous identical requests coalesce", async (t) => {
  const f = await fixture(t);
  let release, entered;
  const wait = new Promise((resolve) => { release = resolve; }), started = new Promise((resolve) => { entered = resolve; });
  f.setFetch(async (_url, options) => { entered(); await wait; return new Response(JSON.stringify(payload(JSON.parse(options.body)))); });
  const first = f.service.refresh(query); await started;
  const second = f.service.refresh(query); release();
  const [a, b] = await Promise.all([first, second]); assert.deepEqual(a, b); assert.equal(f.calls.length, 1);
  a.series[0].ratio = 99; assert.equal(b.series[0].ratio, 0, "callers cannot mutate each other's snapshot");
  f.setTime("2026-09-28T00:59:59.000Z"); assert.equal((await f.service.refresh(query)).cacheReused, true); assert.equal(f.calls.length, 1);
  f.setTime("2026-09-28T01:00:01.000Z"); await f.service.refresh(query); assert.equal(f.calls.length, 2);
});

test("missing credentials do not request data and status never returns keys", async (t) => {
  const f = await fixture(t, { readTrafficKeys: async () => ({ naverClientId: "configured-alone", naverClientSecret: "" }) });
  const result = await f.service.refresh(query); assert.equal(result.configured, false); assert.equal(result.errorCode, "MISSING_KEY"); assert.equal(result.networkAttempted, false);
  const status = await f.service.status(); assert.equal(status.configured, false); assert.equal(status.errorCode, "MISSING_KEY");
  assert.equal(f.calls.length, 0); assert.equal(JSON.stringify(status).includes("configured-alone"), false);
});

test("timeout covers body reading and cancels its request; response size is bounded", async (t) => {
  const f = await fixture(t, { timeoutMs: 15 });
  let signal;
  f.setFetch(async (_url, options) => { signal = options.signal; return { ok: true, status: 200, text: async () => new Promise(() => {}) }; });
  const timed = await f.service.refresh(query); assert.equal(timed.errorCode, "TIMEOUT"); assert.equal(signal.aborted, true); assert.equal(f.calls.length, 1);
  f.setFetch(async () => new Response("irrelevant", { headers: { "Content-Length": String(600 * 1024) } }));
  assert.equal((await f.service.refresh(query)).errorCode, "RESPONSE_TOO_LARGE");
  f.setFetch(async () => new Response("x".repeat(600 * 1024)));
  assert.equal((await f.service.refresh(query)).errorCode, "RESPONSE_TOO_LARGE");
});

test("authentication and arbitrary network errors stay redacted in responses and all stored records", async (t) => {
  const f = await fixture(t);
  f.setFetch(async (_url, options) => {
    assert.equal(options.headers["X-Naver-Client-Secret"], "SECRET-DO-NOT-STORE");
    assert.equal(options.redirect, "error", "never forward credentials through provider redirects");
    return new Response("AUTH private serviceKey=leak", { status: 403 });
  });
  assert.equal((await f.service.refresh(query)).errorCode, "AUTH_ERROR");
  f.setFetch(async () => { throw Object.assign(new Error("SECRET-DO-NOT-STORE serviceKey=leak"), { code: "secret-error-code" }); });
  const result = await f.service.refresh(query); assert.equal(result.errorCode, "NETWORK_ERROR");
  const texts = [JSON.stringify(result), JSON.stringify(await f.service.status()), await fs.readFile(path.join(f.dataDir, "status.json"), "utf8")];
  for (const name of await fs.readdir(path.join(f.dataDir, "cache"))) texts.push(await fs.readFile(path.join(f.dataDir, "cache", name), "utf8"));
  assert.equal(texts.some((text) => /SECRET-DO-NOT-STORE|serviceKey=|secret-error-code|CLIENT-TEST-ONLY/.test(text)), false);
});

test("corrupt cache is reported without overwriting it or triggering a GET provider request", async (t) => {
  const f = await fixture(t); await f.service.refresh(query);
  const filename = (await fs.readdir(path.join(f.dataDir, "cache")))[0], file = path.join(f.dataDir, "cache", filename);
  await fs.writeFile(file, "damaged");
  assert.equal((await f.service.get(query)).errorCode, "CACHE_READ_ERROR");
  assert.equal((await f.service.refresh(query)).errorCode, "CACHE_READ_ERROR");
  assert.equal(f.calls.length, 1); assert.equal(await fs.readFile(file, "utf8"), "damaged");
});
