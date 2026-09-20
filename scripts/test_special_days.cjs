"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createSpecialDaysService, parseResponse, validateYear, CATEGORIES } = require("./lib/special_days.cjs");

const DAY = 86400000;
const row = (overrides = {}) => ({ locdate: 20261003, dateName: "개천절", isHoliday: "Y", seq: 1, dateKind: "01", ...overrides });
function reply(items = [row()], { pageNo = 1, totalCount = items.length, numOfRows = 100, code = "00" } = {}) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ response: { header: { resultCode: code, resultMsg: "NORMAL SERVICE" }, body: { items: { item: items.length === 1 ? items[0] : items }, pageNo, numOfRows, totalCount } } }) };
}
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "staydatalab-special-days-test-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let time = Date.parse("2026-09-21T00:00:00Z");
  const calls = [];
  const fetchImpl = options.fetchImpl || (async () => reply());
  const service = createSpecialDaysService({ dataDir, readServiceKey: () => "fake-test-key", now: () => time, ...options,
    fetchImpl: async (url, init) => { calls.push({ url: new URL(url), init }); return fetchImpl(new URL(url), init); }
  });
  return { service, dataDir, calls, advance: ms => { time += ms; } };
}

test("five documented operations preserve multiple holiday events on the same date", async t => {
  const f = await fixture(t, { fetchImpl: async url => {
    if (url.pathname.endsWith("getRestDeInfo")) return reply([row(), row({ seq: 2, dateName: "추석" }), row({ seq: 3, dateName: "휴일 아님", isHoliday: "N" })]);
    return reply([row({ dateName: url.pathname.endsWith("getAnniversaryInfo") ? "기념일" : "특일" })]);
  } });
  const result = await f.service.getYear(2026);
  assert.equal(result.status, "ready");
  assert.equal(result.items.length, 7);
  assert.deepEqual(result.holidays.map(item => item.name), ["개천절", "추석"]);
  assert.equal(result.categories.holidays.count, 3);
  assert.equal(result.categories.nationalDays.items[0].isHoliday, true);
  assert.equal(result.holidays.length, 2, "Only the rest-day operation determines public holidays");
  assert.deepEqual(f.calls.map(call => call.url.pathname.split("/").at(-1)), CATEGORIES.map(category => category.operation));
  assert.ok(f.calls.every(call => call.url.protocol === "https:" && !call.url.searchParams.has("solMonth")));
  assert.equal(f.calls[0].init.redirect, "error", "Do not forward the key through redirects");
  const status = await f.service.status(2026);
  assert.equal(status.cachedYears[0].year, 2026);
  assert.equal(status.cachedYears[0].count, 7);
  assert.equal(status.yearStatus.status, "ready");
  assert.equal(f.calls.length, 5, "Status is cache-only");
});

test("pagination completes every category, including a singleton final page", async t => {
  const f = await fixture(t, { fetchImpl: async url => {
    const pageNo = Number(url.searchParams.get("pageNo"));
    return reply(pageNo === 1 ? [row({ seq: 1 }), row({ seq: 2 })] : [row({ seq: 3 })], { pageNo, totalCount: 3, numOfRows: 2 });
  } });
  const result = await f.service.getYear("2026");
  assert.equal(result.status, "ready");
  assert.equal(result.categories.holidays.count, 3);
  assert.equal(f.calls.length, 10);
});

test("24-hour cache, expiry and explicit refresh have bounded calls", async t => {
  const f = await fixture(t);
  await f.service.getYear(2026);
  f.advance(DAY - 1);
  assert.equal((await f.service.getYear(2026)).networkAttempted, false);
  assert.equal(f.calls.length, 5);
  f.advance(1);
  assert.equal((await f.service.getYear(2026)).networkAttempted, true);
  assert.equal(f.calls.length, 10);
  await f.service.getYear(2026, { refresh: true });
  assert.equal(f.calls.length, 15);
});

test("partial provider failure keeps the exact previous successful category and retries after cooldown", async t => {
  let failed = false;
  const f = await fixture(t, { fetchImpl: async url => {
    if (failed && url.pathname.endsWith("getRestDeInfo")) return { ok: false, status: 503, text: async () => "secret-bearing error body" };
    return reply([row({ dateName: failed ? "갱신된 특일" : "기존 특일" })]);
  } });
  const initial = await f.service.getYear(2026);
  const goodHoliday = initial.categories.holidays;
  f.advance(DAY);
  failed = true;
  const result = await f.service.getYear(2026);
  assert.equal(result.status, "partial");
  assert.equal(result.categories.holidays.status, "stale");
  assert.equal(result.categories.holidays.updatedAt, goodHoliday.updatedAt);
  assert.deepEqual(result.categories.holidays.items, goodHoliday.items);
  assert.equal(result.categories.nationalDays.items[0].name, "갱신된 특일");
  assert.equal(result.errors[0].code, "SERVICE_UNAVAILABLE");
  const onDisk = JSON.parse(await fs.readFile(path.join(f.dataDir, "special-days-2026.json"), "utf8"));
  assert.deepEqual(onDisk.categories.holidays.items, goodHoliday.items);
  assert.doesNotMatch(JSON.stringify(result), /secret-bearing/);
  const calls = f.calls.length;
  f.advance(299999);
  await f.service.getYear(2026);
  assert.equal(f.calls.length, calls);
  f.advance(1);
  failed = false;
  assert.equal((await f.service.getYear(2026)).status, "ready");
  assert.equal(f.calls.length, calls + 1);
});

test("a failed refresh cannot overwrite any successful cache or expose fetch errors and keys", async t => {
  let fail = false;
  const f = await fixture(t, { readServiceKey: () => "test-only-secret+/%=", fetchImpl: async url => {
    if (fail) throw new Error(`failed URL ${url}`);
    return reply();
  } });
  await f.service.getYear(2026);
  const location = path.join(f.dataDir, "special-days-2026.json");
  const before = await fs.readFile(location, "utf8");
  fail = true;
  const result = await f.service.getYear(2026, { refresh: true });
  assert.equal(result.status, "partial");
  assert.equal(await fs.readFile(location, "utf8"), before);
  assert.doesNotMatch(JSON.stringify(result), /test-only-secret|ServiceKey|failed URL|%2B/);
  assert.equal(result.errors[0].code, "NETWORK_ERROR");
  const verified = await f.service.verify(2026);
  assert.equal(verified.ok, false);
  assert.doesNotMatch(JSON.stringify(await f.service.status()), /test-only-secret|ServiceKey|failed URL/);
});

test("encoded and decoded keys are encoded exactly once, without appearing in disk or public output", async t => {
  const decoded = "fake+/test==";
  const f = await fixture(t, { readServiceKey: () => encodeURIComponent(decoded) });
  const result = await f.service.getYear(2026);
  assert.equal(f.calls[0].url.searchParams.get("ServiceKey"), decoded);
  assert.doesNotMatch(JSON.stringify(result), /fake|ServiceKey/);
  assert.doesNotMatch(await fs.readFile(path.join(f.dataDir, "special-days-2026.json"), "utf8"), /fake|ServiceKey/);
});

test("missing keys make no network requests and do not create zero-holiday cache entries", async t => {
  const f = await fixture(t, { readServiceKey: () => "" });
  const result = await f.service.getYear(2026);
  assert.equal(result.status, "missing_key");
  assert.equal(result.networkAttempted, false);
  assert.equal(result.categories.holidays.updatedAt, null);
  assert.equal(result.categories.holidays.error.code, "MISSING_KEY");
  assert.equal((await f.service.verify(2026)).status, "missing_key");
  assert.equal((await f.service.status()).configured, false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await fs.readdir(f.dataDir), []);
});

test("valid no-data responses differ from missing configuration and malformed responses", async t => {
  const f = await fixture(t, { fetchImpl: async () => reply([]) });
  const result = await f.service.getYear(2026);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.holidays, []);
  assert.ok(result.categories.holidays.updatedAt);
  assert.equal(result.categories.holidays.error, null);
});

test("XML success preserves entities, same-date events and solar-term metadata", async t => {
  const xml = `<?xml version="1.0"?><response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header><body><items><item><locdate>20260923</locdate><dateName>추분 &amp; 절기</dateName><isHoliday>N</isHoliday><seq>1</seq><dateKind>03</dateKind><kst>0905</kst><sunLongitude>180</sunLongitude></item><item><locdate>20260923</locdate><dateName><![CDATA[같은 날 <특일>]]></dateName><isHoliday>Y</isHoliday><seq>2</seq><dateKind>01</dateKind></item></items><numOfRows>100</numOfRows><pageNo>1</pageNo><totalCount>2</totalCount></body></response>`;
  const f = await fixture(t, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => xml }) });
  const result = await f.service.getYear(2026);
  assert.equal(result.status, "ready");
  assert.equal(result.categories.solarTerms.items[0].kst, "0905");
  assert.equal(result.categories.solarTerms.items[0].sunLongitude, "180");
  assert.equal(result.categories.solarTerms.items[0].name, "추분 & 절기");
  assert.equal(result.holidays[0].name, "같은 날 <특일>");
});

test("HTTP 200 XML authentication error is a safe failure, not an empty successful calendar", async t => {
  const xml = `<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR test-secret</errMsg><returnAuthMsg>KEY test-secret</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>`;
  const f = await fixture(t, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => xml }) });
  const result = await f.service.getYear(2026);
  assert.equal(result.status, "error");
  assert.equal(result.errors[0].code, "AUTH_ERROR");
  assert.doesNotMatch(JSON.stringify(result), /test-secret|KEY/);
  assert.deepEqual(await fs.readdir(f.dataDir), []);
  await f.service.getYear(2026);
  assert.equal(f.calls.length, 5, "Default requests honor the failure cooldown");
});

test("bad dates, wrong years and incomplete pagination never replace valid snapshots", async t => {
  let mode = "good";
  const f = await fixture(t, { fetchImpl: async url => {
    if (mode === "date") return reply([row({ locdate: 20260230 })]);
    if (mode === "year") return reply([row({ locdate: 20271003 })]);
    if (mode === "pagination") return reply([], { pageNo: Number(url.searchParams.get("pageNo")), totalCount: 1 });
    return reply();
  } });
  await f.service.getYear(2026);
  const location = path.join(f.dataDir, "special-days-2026.json");
  const original = await fs.readFile(location, "utf8");
  for (mode of ["date", "year", "pagination"]) {
    const result = await f.service.getYear(2026, { refresh: true });
    assert.equal(result.status, "partial");
    assert.equal(result.errors[0].code, "INVALID_RESPONSE");
    assert.equal(await fs.readFile(location, "utf8"), original);
  }
});

test("XML DTDs, HTML, invalid totals and oversized payloads are rejected", () => {
  for (const value of ["<!DOCTYPE response [<!ENTITY x SYSTEM 'file:///secret'>]><response/>", "<html>upstream error</html>", "{}", JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: "", pageNo: 1, numOfRows: 100, totalCount: -1 } } }), "x".repeat(2 * 1024 * 1024 + 1)]) {
    assert.throws(() => parseResponse(value), error => error.code === "INVALID_RESPONSE");
  }
});

test("timeouts and quota responses are distinct, sanitized failures", async t => {
  const timeout = await fixture(t, { timeoutMs: 2, fetchImpl: async () => new Promise(() => {}) });
  assert.equal((await timeout.service.getYear(2026)).errors[0].code, "TIMEOUT");
  assert.ok(timeout.calls.every(call => call.init.signal.aborted));
  const quota = await fixture(t, { fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.equal((await quota.service.getYear(2026)).errors[0].code, "QUOTA_EXCEEDED");
});

test("same-year simultaneous requests share work and verification does not overwrite the full cache", async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.service.getYear(2026), f.service.getYear(2026)]);
  assert.deepEqual(first, second);
  assert.equal(f.calls.length, 5);
  const file = path.join(f.dataDir, "special-days-2026.json");
  const before = await fs.readFile(file, "utf8");
  assert.equal((await f.service.verify(2026)).ok, true);
  assert.equal(f.calls.length, 6);
  assert.equal(f.calls[5].url.searchParams.get("numOfRows"), "1");
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.equal((await f.service.status()).lastVerification.ok, true);
});

test("year input validation cannot become a path or query injection", async t => {
  const f = await fixture(t);
  assert.throws(() => validateYear(undefined), error => error.code === "INVALID_YEAR");
  for (const value of [null, true, "../2026", "2026&ServiceKey=other", "2026.0", 1999, 2101, 2026.2, " 2026 "]) {
    assert.throws(() => validateYear(value), error => error.code === "INVALID_YEAR" && error.statusCode === 400);
    await assert.rejects(f.service.getYear(value), error => error.code === "INVALID_YEAR");
  }
  assert.equal(validateYear(2000), 2000);
  assert.equal(validateYear("2100"), 2100);
  assert.equal(f.calls.length, 0);
});

test("omitted year uses Korea time and repeated provider pages cannot masquerade as complete", async t => {
  const f = await fixture(t, { now: () => Date.parse("2026-12-31T15:01:00Z"), fetchImpl: async url => {
    const pageNo = Number(url.searchParams.get("pageNo"));
    return reply([row({ locdate: 20271003 })], { pageNo, totalCount: 2, numOfRows: 1 });
  } });
  const result = await f.service.getYear();
  assert.equal(result.year, 2027);
  assert.equal(result.status, "error");
  assert.equal(result.errors[0].code, "INVALID_RESPONSE");
  assert.deepEqual(await fs.readdir(f.dataDir), []);
});

test("cache write errors are returned safely and a restarted service reuses disk snapshots", async t => {
  const f = await fixture(t);
  await f.service.getYear(2026);
  const restarted = createSpecialDaysService({ dataDir: f.dataDir, readServiceKey: () => "", now: () => Date.parse("2026-09-21T01:00:00Z"), fetchImpl: async () => { throw new Error("Network must not run"); } });
  const cached = await restarted.getYear(2026);
  assert.equal(cached.configured, false);
  assert.equal(cached.status, "ready");
  assert.equal(cached.networkAttempted, false);
  assert.equal(cached.holidays.length, 1);
  const blockedPath = path.join(f.dataDir, "blocked-directory");
  await fs.writeFile(blockedPath, "unrelated preserved file");
  const blocked = createSpecialDaysService({ dataDir: blockedPath, readServiceKey: () => "test-only-key", fetchImpl: async () => reply() });
  const failed = await blocked.getYear(2026);
  assert.equal(failed.status, "error");
  assert.equal(failed.errors[0].code, "CACHE_WRITE_ERROR");
  assert.equal(await fs.readFile(blockedPath, "utf8"), "unrelated preserved file");
  assert.doesNotMatch(JSON.stringify(failed), /blocked-directory|test-only-key/);
});
