"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createTourismForecastService, validateRegion, parseResponse } = require("./lib/tourism_forecast.cjs");
const region = { areaCd: "51", signguCd: "51130" };
const dateAt = (date, offset) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10).replaceAll("-", "");
function rows(name = "간현관광지", inputRegion = region, start = "2026-09-20") {
  return Array.from({ length: 30 }, (_, index) => ({ baseYmd: dateAt(start, index), areaCd: inputRegion.areaCd, areaNm: "강원특별자치도", signguCd: inputRegion.signguCd, signguNm: "원주시", tAtsNm: name, cnctrRate: String(index === 0 ? 0 : index === 29 ? 100 : 22.5) }));
}
function reply(items = rows(), { code = "0000", pageNo = 1, numOfRows = 1000, totalCount = items.length } = {}) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ response: { header: { resultCode: code, resultMsg: "OK" }, body: { items: { item: items.length === 1 ? items[0] : items }, pageNo, numOfRows, totalCount } } }) };
}
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "staydatalab-tourism-forecast-test-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let instant = Date.parse("2026-09-21T01:00:00Z");
  const calls = [];
  const fetchImpl = options.fetchImpl || (async () => reply());
  const service = createTourismForecastService({ dataDir, readServiceKey: () => "fake-test-key", now: () => instant, ...options,
    fetchImpl: async (url, init) => { calls.push({ url: new URL(url), init }); return fetchImpl(new URL(url), init); }
  });
  return { service, dataDir, calls, advance: ms => { instant += ms; } };
}

test("official region directory is exact and status does not collect forecasts", async t => {
  const f = await fixture(t);
  const status = await f.service.status();
  assert.equal(status.regions.length, 252);
  assert.equal(new Set(status.regions.map(item => item.areaCd)).size, 17);
  assert.deepEqual(validateRegion(region), { areaCd: "51", areaNm: "강원특별자치도", signguCd: "51130", signguNm: "원주시" });
  assert.equal(validateRegion({ areaCd: "41", signguCd: "41650" }).signguNm, "포천시");
  assert.equal(f.calls.length, 0);
  assert.deepEqual(status.cachedRegions, []);
});

test("provider dates and genuine zero remain intact, with only 29 upcoming days for yesterday's start", async t => {
  const f = await fixture(t);
  const result = await f.service.getRegionForecast(region);
  assert.equal(result.status, "ready");
  const destination = result.destinations[0];
  assert.equal(destination.startDate, "2026-09-20");
  assert.equal(destination.endDate, "2026-10-19");
  assert.equal(destination.series.length, 30);
  assert.equal(destination.series[0].value, 0);
  assert.equal(destination.series[29].value, 100);
  assert.equal(destination.upcomingDayCount, 29);
  assert.equal(destination.providerLagDays, 1);
  assert.equal(destination.complete, true);
  assert.deepEqual(JSON.parse(Buffer.from(destination.id, "base64url").toString("utf8")), ["51", "51130", "간현관광지"]);
  const request = f.calls[0];
  assert.equal(request.url.origin, "https://apis.data.go.kr");
  assert.equal(request.url.pathname, "/B551011/TatsCnctrRateService/tatsCnctrRatedList");
  assert.equal(request.url.searchParams.get("MobileOS"), "ETC");
  assert.equal(request.url.searchParams.get("numOfRows"), "1000");
  assert.equal(request.url.searchParams.get("_type"), "json");
  assert.equal(request.url.searchParams.has("tAtsNm"), false, "One selected region supplies both names and forecasts");
  assert.equal(request.init.redirect, "error");
});

test("1530 regional rows use two requests and a destination split across pages remains complete", async t => {
  const pocheon = { areaCd: "41", signguCd: "41650" };
  const source = Array.from({ length: 51 }, (_, index) => rows(`관광지 ${String(index + 1).padStart(2, "0")}`, pocheon)).flat();
  const f = await fixture(t, { fetchImpl: async url => {
    const pageNo = Number(url.searchParams.get("pageNo"));
    return reply(source.slice((pageNo - 1) * 1000, pageNo * 1000), { pageNo, totalCount: source.length });
  } });
  const result = await f.service.getRegionForecast(pocheon);
  assert.equal(result.status, "ready");
  assert.equal(result.destinations.length, 51);
  assert.equal(result.destinations[33].series.length, 30);
  assert.ok(result.destinations.every(item => item.complete && item.signguCd === "41650"));
  assert.equal(f.calls.length, 2);
  await f.service.getRegionForecast(pocheon);
  assert.equal(f.calls.length, 2, "Changing local name selection needs no new provider request");
});

test("same-day cache is reused and KST date rollover refreshes once", async t => {
  const f = await fixture(t);
  const first = await f.service.getRegionForecast(region);
  f.advance(13 * 3600000);
  assert.equal((await f.service.getRegionForecast(region)).networkAttempted, false);
  f.advance(3600000);
  const next = await f.service.getRegionForecast(region);
  assert.equal(next.queryDate, "2026-09-22");
  assert.notEqual(next.collectedAt, first.collectedAt);
  assert.equal(next.networkAttempted, true);
  assert.equal(f.calls.length, 2);
});

test("requests spanning midnight retain the true completion timestamp and request date", async t => {
  let instant = Date.parse("2026-09-21T14:59:59Z");
  const f = await fixture(t, { now: () => instant, fetchImpl: async () => { instant += 2000; return reply(); } });
  const first = await f.service.getRegionForecast(region);
  assert.equal(first.queryDate, "2026-09-21");
  assert.equal(first.collectedAt, "2026-09-21T15:00:01.000Z");
  assert.equal(first.stale, true);
  assert.equal(first.status, "partial");
  const status = await f.service.status();
  assert.equal(status.cachedRegions[0].collectedAt, first.collectedAt);
  const next = await f.service.getRegionForecast(region);
  assert.equal(next.queryDate, "2026-09-22");
  assert.equal(next.networkAttempted, true);
  assert.equal(f.calls.length, 2);
});

test("failed refresh preserves a good file, returns safe errors and honors retry cooldown", async t => {
  let fail = false;
  const f = await fixture(t, { fetchImpl: async url => {
    if (fail) throw new Error(`raw-secret URL ${url}`);
    return reply();
  } });
  const first = await f.service.getRegionForecast(region);
  const file = path.join(f.dataDir, "tourism-forecast-51-51130.json");
  const original = await fs.readFile(file, "utf8");
  fail = true;
  const failed = await f.service.getRegionForecast(region, { refresh: true });
  assert.equal(failed.status, "partial");
  assert.equal(failed.stale, true);
  assert.equal(failed.collectedAt, first.collectedAt);
  assert.deepEqual(failed.destinations, first.destinations);
  assert.equal(failed.errors[0].code, "NETWORK_ERROR");
  assert.doesNotMatch(JSON.stringify(failed), /raw-secret|fake-test-key|serviceKey|https.*TatsCnctr/);
  assert.equal(await fs.readFile(file, "utf8"), original);
  f.advance(299999);
  assert.equal((await f.service.getRegionForecast(region)).networkAttempted, false);
  f.advance(1);
  fail = false;
  assert.equal((await f.service.getRegionForecast(region)).status, "ready");
  assert.equal(f.calls.length, 3);
});

test("no-data codes and empty successful responses are not zero forecasts", async t => {
  for (const code of ["03", "0003", "0000"]) {
    const f = await fixture(t, { fetchImpl: async () => reply([], { code }) });
    const result = await f.service.getRegionForecast(region);
    assert.equal(result.status, "no_data");
    assert.deepEqual(result.destinations, []);
    assert.equal(result.errors[0].code, "NO_DATA");
    await f.service.getRegionForecast(region);
    assert.equal(f.calls.length, 1, "A known no-data region does not consume a request on every render");
  }
});

test("no-data refresh retains earlier good forecasts instead of replacing them with an empty list", async t => {
  let noData = false;
  const f = await fixture(t, { fetchImpl: async () => noData ? reply([], { code: "03" }) : reply() });
  await f.service.getRegionForecast(region);
  const file = path.join(f.dataDir, "tourism-forecast-51-51130.json");
  const original = await fs.readFile(file, "utf8");
  noData = true;
  const result = await f.service.getRegionForecast(region, { refresh: true });
  assert.equal(result.status, "partial");
  assert.equal(result.errors[0].code, "NO_DATA");
  assert.equal(result.destinations.length, 1);
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("missing rates, invalid ranges, missing dates, repeats and foreign regions are rejected without cache loss", async t => {
  let responseRows = rows();
  const f = await fixture(t, { fetchImpl: async () => reply(responseRows) });
  await f.service.getRegionForecast(region);
  const file = path.join(f.dataDir, "tourism-forecast-51-51130.json");
  const original = await fs.readFile(file, "utf8");
  const invalid = [
    ...[null, "", " ", false, [], {}, -1, 101, "Infinity", "0x10"].map(value => rows().map((row, index) => index ? row : { ...row, cnctrRate: value })),
    rows().slice(0, 29), rows().concat(rows()[0]),
    rows().map((row, index) => index ? row : { ...row, baseYmd: "20260230" }),
    rows().map((row, index) => index ? row : { ...row, signguCd: "41650" }),
    rows("다른 지역", { areaCd: "41", signguCd: "41650" }),
    rows("먼 미래", region, "2026-10-01")
  ];
  for (responseRows of invalid) {
    const result = await f.service.getRegionForecast(region, { refresh: true });
    assert.equal(result.status, "partial");
    assert.equal(result.errors[0].code, "INVALID_RESPONSE");
    assert.equal(await fs.readFile(file, "utf8"), original);
  }
});

test("same destination name in different regions has distinct internal identities", async t => {
  const f = await fixture(t, { fetchImpl: async url => reply(rows("동일 관광지", { areaCd: url.searchParams.get("areaCd"), signguCd: url.searchParams.get("signguCd") })) });
  const first = await f.service.getRegionForecast(region);
  const second = await f.service.getRegionForecast({ areaCd: "41", signguCd: "41650" });
  assert.notEqual(first.destinations[0].id, second.destinations[0].id);
  assert.equal(first.destinations[0].signguNm, "원주시");
  assert.equal(second.destinations[0].signguNm, "포천시");
});

test("a provider window older than an existing one cannot replace it", async t => {
  let start = "2026-09-21";
  const f = await fixture(t, { fetchImpl: async () => reply(rows("간현관광지", region, start)) });
  await f.service.getRegionForecast(region);
  start = "2026-09-20";
  const result = await f.service.getRegionForecast(region, { refresh: true });
  assert.equal(result.status, "partial");
  assert.equal(result.errors[0].code, "STALE_RESPONSE");
  assert.equal(result.destinations[0].startDate, "2026-09-21");
});

test("success XML, authentication XML and DTD rejection use no external parser or entities", async t => {
  const body = rows().map(row => `<item>${Object.entries(row).map(([key, value]) => `<${key}>${value}</${key}>`).join("")}</item>`).join("");
  const xml = `<response><header><resultCode>0000</resultCode></header><body><items>${body}</items><numOfRows>1000</numOfRows><pageNo>1</pageNo><totalCount>30</totalCount></body></response>`;
  const f = await fixture(t, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => xml }) });
  assert.equal((await f.service.getRegionForecast(region)).status, "ready");
  const auth = `<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode><returnAuthMsg>key secret</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>`;
  assert.throws(() => parseResponse(auth), error => error.code === "AUTH_ERROR" && !error.message.includes("secret"));
  assert.throws(() => parseResponse('<!DOCTYPE response [<!ENTITY x SYSTEM "file:///secret">]>' + xml), error => error.code === "INVALID_RESPONSE");
  assert.throws(() => parseResponse("<html>upstream error</html>"), error => error.code === "INVALID_RESPONSE");
});

test("pagination truncation and an empty later page fail instead of persisting a partial destination list", async t => {
  const f = await fixture(t, { fetchImpl: async url => {
    const pageNo = Number(url.searchParams.get("pageNo"));
    return reply(pageNo === 1 ? rows() : [], { pageNo, totalCount: 60 });
  } });
  const result = await f.service.getRegionForecast(region);
  assert.equal(result.status, "error");
  assert.equal(result.errors[0].code, "INVALID_RESPONSE");
  assert.deepEqual(await fs.readdir(f.dataDir), []);
});

test("no key, invalid region, quota and timeout are safe distinct failures", async t => {
  const missing = await fixture(t, { readServiceKey: () => "" });
  assert.equal((await missing.service.getRegionForecast(region)).status, "missing_key");
  assert.equal(missing.calls.length, 0);
  for (const value of [undefined, {}, { areaCd: "42", signguCd: "42130" }, { areaCd: "51", signguCd: "41650" }, { areaCd: "../51", signguCd: "51130" }]) await assert.rejects(missing.service.getRegionForecast(value), error => error.code === "INVALID_REGION" && error.statusCode === 400);
  const quota = await fixture(t, { fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.equal((await quota.service.getRegionForecast(region)).errors[0].code, "QUOTA_EXCEEDED");
  const timeout = await fixture(t, { timeoutMs: 2, fetchImpl: async () => new Promise(() => {}) });
  assert.equal((await timeout.service.getRegionForecast(region)).errors[0].code, "TIMEOUT");
  assert.equal(timeout.calls[0].init.signal.aborted, true);
});

test("encoded keys are encoded once and never written to cache, API response or status", async t => {
  const key = "test-secret+/==";
  const f = await fixture(t, { readServiceKey: () => encodeURIComponent(key) });
  const result = await f.service.getRegionForecast(region);
  assert.equal(f.calls[0].url.searchParams.get("serviceKey"), key);
  assert.equal(f.calls[0].url.searchParams.has("ServiceKey"), false);
  assert.doesNotMatch(JSON.stringify(result), /test-secret|serviceKey/);
  assert.doesNotMatch(JSON.stringify(await f.service.status()), /test-secret|serviceKey/);
  assert.doesNotMatch(await fs.readFile(path.join(f.dataDir, "tourism-forecast-51-51130.json"), "utf8"), /test-secret|serviceKey/);
});

test("simultaneous requests share regional work and existing snapshots survive restart without a key", async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.service.getRegionForecast(region), f.service.getRegionForecast(region)]);
  assert.deepEqual(first, second);
  assert.equal(f.calls.length, 1);
  const restarted = createTourismForecastService({ dataDir: f.dataDir, now: () => Date.parse("2026-09-21T02:00:00Z"), readServiceKey: () => "", fetchImpl: async () => { throw Error("must not run"); } });
  assert.equal((await restarted.status()).configured, false);
  const cached = await restarted.getRegionForecast(region);
  assert.equal(cached.status, "ready");
  assert.equal(cached.networkAttempted, false);
  assert.deepEqual(cached.destinations, first.destinations);
});

test("cache write failure returns a safe status and preserves unrelated files", async t => {
  const f = await fixture(t);
  const blocker = path.join(f.dataDir, "file-not-directory");
  await fs.writeFile(blocker, "preserved");
  const service = createTourismForecastService({ dataDir: blocker, readServiceKey: () => "test-key", now: () => Date.parse("2026-09-21T01:00:00Z"), fetchImpl: async () => reply() });
  const result = await service.getRegionForecast(region);
  assert.equal(result.status, "error");
  assert.equal(result.errors[0].code, "CACHE_WRITE_ERROR");
  assert.equal(await fs.readFile(blocker, "utf8"), "preserved");
  assert.doesNotMatch(JSON.stringify(result), /file-not-directory|test-key/);
});
