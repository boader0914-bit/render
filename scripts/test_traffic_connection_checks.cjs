"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { createTrafficConnectionChecks, parseTrafficVerificationRequest } = require("./lib/traffic_connection_checks.cjs");

const DUMMY_KEYS = Object.freeze({ naverClientId: "dummy-datalab-id", naverClientSecret: "dummy-datalab-secret", searchadApiKey: "dummy-searchad-api-key", searchadSecretKey: "dummy-searchad-secret", searchadCustomerId: "dummy-searchad-customer" });
const reply = (status, data) => ({ status, text: async () => JSON.stringify(data) });
function successReply(url, options) {
  if (url.includes("datalab")) return reply(200, { results: [{ title: "글램핑", data: [{ period: JSON.parse(options.body).endDate, ratio: 0 }] }] });
  return reply(200, { keywordList: [{ relKeyword: "글램핑", monthlyPcQcCnt: 0, monthlyMobileQcCnt: "< 10" }] });
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "traffic-check-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const state = { now: Date.parse("2026-10-31T01:00:00.000Z"), keys: { ...DUMMY_KEYS }, calls: [] };
  const filePath = path.join(directory, "config", "traffic_api_verification.json");
  const create = () => createTrafficConnectionChecks({ filePath, readKeys: async () => ({ ...state.keys }), clock: () => state.now,
    fetchImpl: async (...args) => { state.calls.push(args); return (options.fetchImpl || successReply)(...args); }, ...(options.service || {}) });
  return { directory, filePath, state, create, service: create() };
}

test("GET-style status distinguishes configured from untested without calling a provider or writing", async t => {
  const f = await fixture(t), status = await f.service.status();
  assert.equal(status.recordState, "missing");
  for (const provider of ["datalab", "searchad"]) {
    assert.equal(status[provider].configured, true); assert.equal(status[provider].checkStatus, "unverified");
    assert.equal(status[provider].ok, false); assert.equal(status[provider].status, null);
  }
  assert.equal(f.state.calls.length, 0);
  await assert.rejects(fs.stat(f.filePath), { code: "ENOENT" });
});

test("manual DataLab test persists safe metadata across a service restart and accepts real observed zero", async t => {
  const f = await fixture(t), result = await f.service.verify("datalab");
  assert.equal(result.datalab.checkStatus, "verified"); assert.equal(result.datalab.ok, true);
  assert.equal(result.searchad.checkStatus, "unverified"); assert.equal(f.state.calls.length, 1);
  const [url, options] = f.state.calls[0];
  assert.equal(url, "https://openapi.naver.com/v1/datalab/search"); assert.equal(options.redirect, "error");
  assert.equal(options.method, "POST"); assert.equal(JSON.parse(options.body).keywordGroups[0].groupName, "글램핑");
  const saved = await f.create().status();
  assert.equal(saved.datalab.checkedAt, result.datalab.checkedAt); assert.equal(saved.datalab.validForCurrentKeys, true);
  assert.equal(saved.datalab.stale, false); assert.equal(f.state.calls.length, 1);
  const disk = await fs.readFile(f.filePath, "utf8"), publicText = JSON.stringify(result);
  for (const key of Object.values(DUMMY_KEYS)) { assert.equal(disk.includes(key), false); assert.equal(publicText.includes(key), false); }
  assert.equal(publicText.includes("fingerprint"), false);
  if (process.platform !== "win32") assert.equal((await fs.stat(f.filePath)).mode & 0o777, 0o600);
});

test("manual SearchAd test only calls the SearchAd endpoint once", async t => {
  const f = await fixture(t), result = await f.service.verify("searchad");
  assert.equal(result.searchad.checkStatus, "verified"); assert.equal(result.datalab.checkStatus, "unverified");
  assert.equal(f.state.calls.length, 1); const [url, options] = f.state.calls[0];
  assert.match(url, /^https:\/\/api\.searchad\.naver\.com\/keywordstool\?/); assert.equal(options.method, "GET");
  assert.equal(options.redirect, "error"); assert.equal(typeof options.headers["X-Signature"], "string");
});

test("legacy all checks keep successful service independent of an authentication failure and ignore provider error text", async t => {
  const f = await fixture(t, { fetchImpl: (url, options) => url.includes("searchad") ? reply(403, { errorMessage: "sensitive-provider-body" }) : successReply(url, options) });
  const result = await f.service.verify();
  assert.equal(result.datalab.checkStatus, "verified"); assert.equal(result.searchad.checkStatus, "failed");
  assert.equal(result.searchad.errorCode, "AUTH_ERROR"); assert.equal(result.searchad.status, 403);
  assert.equal(JSON.stringify(result).includes("sensitive-provider-body"), false); assert.equal(f.state.calls.length, 2);
  const saved = await f.create().status(); assert.equal(saved.datalab.ok, true); assert.equal(saved.searchad.ok, false);
});

test("HTTP200 empty data is no_data, and malformed/incorrect period responses are not verified", async t => {
  for (const provider of ["datalab", "searchad"]) {
    const f = await fixture(t, { fetchImpl: () => reply(200, provider === "datalab" ? { results: [] } : { keywordList: [] }) });
    const result = await f.service.verify(provider); assert.equal(result[provider].checkStatus, "no_data"); assert.equal(result[provider].ok, false);
    assert.equal(result[provider].errorCode, "NO_DATA");
  }
  const malformed = await fixture(t, { fetchImpl: () => reply(200, { errorCode: "upstream-error", errorMessage: "private-text" }) });
  assert.equal((await malformed.service.verify("datalab")).datalab.errorCode, "INVALID_RESPONSE");
  const wrongPeriod = await fixture(t, { fetchImpl: () => reply(200, { results: [{ title: "글램핑", data: [{ period: "2020-01-01", ratio: 50 }] }] }) });
  assert.equal((await wrongPeriod.service.verify("datalab")).datalab.errorCode, "INVALID_RESPONSE");
});

test("429 is recorded with no retry; persisted cooldown skips a new test without changing its checkedAt", async t => {
  const f = await fixture(t, { fetchImpl: () => reply(429, { message: "quota-provider-details" }) });
  const first = await f.service.verify("searchad"); assert.equal(first.searchad.checkStatus, "limited"); assert.equal(f.state.calls.length, 1);
  f.state.now += 1000; const second = await f.create().verify("searchad");
  assert.equal(second.test.testSkipped, true); assert.equal(second.test.attempts[0].reason, "COOLDOWN");
  assert.equal(second.searchad.checkedAt, first.searchad.checkedAt); assert.equal(f.state.calls.length, 1);
  f.state.now += 60000; await f.service.verify("searchad"); assert.equal(f.state.calls.length, 2);
});

test("same-provider concurrent tests share one in-flight request", async t => {
  let release, started; const start = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { fetchImpl: async (url, options) => { started(); await new Promise(resolve => { release = resolve; }); return successReply(url, options); } });
  const first = f.service.verify("datalab"); await start;
  const second = f.service.verify("datalab"); await Promise.resolve();
  assert.equal((await f.service.status()).datalab.checkStatus, "checking"); release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.datalab.ok, true); assert.equal(b.datalab.ok, true); assert.equal(f.state.calls.length, 1);
  assert.equal(b.test.attempts[0].shared, true);
});

test("concurrent distinct-service tests preserve both metadata results", async t => {
  const f = await fixture(t);
  await Promise.all([f.service.verify("datalab"), f.service.verify("searchad")]);
  const status = await f.create().status(); assert.equal(status.datalab.ok, true); assert.equal(status.searchad.ok, true);
  assert.equal(f.state.calls.length, 2);
});

test("changing effective DataLab credentials invalidates only DataLab without a provider call", async t => {
  const f = await fixture(t); await f.service.verify("all");
  f.state.keys.naverClientSecret = "dummy-new-effective-secret";
  const status = await f.service.status();
  assert.equal(status.datalab.checkStatus, "key_changed"); assert.equal(status.datalab.validForCurrentKeys, false); assert.equal(status.datalab.ok, false);
  assert.equal(status.searchad.checkStatus, "verified"); assert.equal(status.searchad.validForCurrentKeys, true);
  assert.equal(f.state.calls.length, 2);
});

test("24-hour-old results remain explicitly stale historical tests, not fresh network evidence", async t => {
  const f = await fixture(t); const before = await f.service.verify("datalab");
  f.state.now += 24 * 3600000;
  const after = await f.service.status(); assert.equal(after.datalab.stale, true); assert.equal(after.datalab.checkedAt, before.datalab.checkedAt);
  assert.equal(after.datalab.checkStatus, "verified"); assert.equal(after.datalab.validForCurrentKeys, true); assert.equal(f.state.calls.length, 1);
});

test("missing keys do not start a check or create a record", async t => {
  const f = await fixture(t); f.state.keys = {};
  const result = await f.service.verify("all");
  assert.equal(result.datalab.checkStatus, "not_configured"); assert.equal(result.searchad.errorCode, "MISSING_KEY");
  assert.equal(result.test.testSkipped, true); assert.equal(f.state.calls.length, 0); await assert.rejects(fs.stat(f.filePath), { code: "ENOENT" });
});

test("corrupt and unsafe records are unknown and do not trigger a provider test or overwrite", async t => {
  const f = await fixture(t); await fs.mkdir(path.dirname(f.filePath)); await fs.writeFile(f.filePath, "not-json");
  const before = await fs.readFile(f.filePath, "utf8");
  const status = await f.service.status(); assert.equal(status.recordState, "unavailable"); assert.equal(status.datalab.checkStatus, "unknown");
  const check = await f.service.verify("datalab"); assert.equal(check.test.attempts[0].reason, "CHECK_RECORD_UNAVAILABLE");
  assert.equal(await fs.readFile(f.filePath, "utf8"), before); assert.equal(f.state.calls.length, 0);
  const g = await fixture(t); await fs.mkdir(path.dirname(g.filePath)); await fs.mkdir(g.filePath);
  assert.equal((await g.service.status()).searchad.checkStatus, "unknown");
  await g.service.verify("searchad"); assert.equal(g.state.calls.length, 0);
});

test("hardlinked metadata is rejected rather than followed or overwritten", async t => {
  const f = await fixture(t); await f.service.verify("datalab"); await fs.link(f.filePath, path.join(f.directory, "receipt-link.json"));
  const before = await fs.readFile(f.filePath, "utf8"), status = await f.service.status();
  assert.equal(status.datalab.checkStatus, "unknown"); await f.service.verify("datalab");
  assert.equal(await fs.readFile(f.filePath, "utf8"), before); assert.equal(f.state.calls.length, 1);
});

test("contradictory persisted state, code, HTTP and timestamps fail closed even with a matching credential fingerprint", async t => {
  const f = await fixture(t); await f.service.verify("datalab");
  const original = JSON.parse(await fs.readFile(f.filePath, "utf8"));
  const cases = [
    { checkStatus: "verified", errorCode: "AUTH_ERROR", status: 403 },
    { checkStatus: "verified", errorCode: "OK", status: null },
    { checkStatus: "no_data", errorCode: "NO_DATA", status: 403 },
    { checkStatus: "limited", errorCode: "QUOTA_EXCEEDED", status: 200 },
    { checkStatus: "checking", errorCode: "CHECK_IN_PROGRESS", status: 200, checkedAt: "" },
    { checkStatus: "failed", errorCode: "OK", status: 200 },
    { checkStatus: "failed", errorCode: "AUTH_ERROR", status: 200 },
    { checkedAt: "2026-10-31T00:59:59.999Z" }
  ];
  for (const change of cases) {
    const data = structuredClone(original); Object.assign(data.providers.datalab, change);
    await fs.writeFile(f.filePath, JSON.stringify(data));
    const status = await f.service.status();
    assert.equal(status.recordState, "unavailable"); assert.equal(status.datalab.checkStatus, "unknown");
    assert.equal(status.datalab.ok, false); assert.equal(status.datalab.errorCode, "CHECK_RECORD_UNAVAILABLE");
    const tested = await f.service.verify("datalab"); assert.equal(tested.test.testSkipped, true);
  }
  assert.equal(f.state.calls.length, 1);
});

test("timeout aborts one dedicated probe and preserves the other service result", async t => {
  const f = await fixture(t, { service: { timeoutMs: 15 }, fetchImpl: (url, options) => url.includes("datalab") ? new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("private-network-error")), { once: true })) : successReply(url, options) });
  const result = await f.service.verify("all");
  assert.equal(result.datalab.errorCode, "TIMEOUT"); assert.equal(result.searchad.ok, true); assert.equal(f.state.calls.length, 2);
  assert.equal(f.state.calls.find(([url]) => url.includes("datalab"))[1].signal.aborted, true); assert.equal(JSON.stringify(result).includes("private-network-error"), false);
});

test("network errors and oversized response bodies use fixed safe messages", async t => {
  const f = await fixture(t, { fetchImpl: () => { throw new Error("private-network-message-dummy-key"); } });
  const failed = await f.service.verify("searchad"); assert.equal(failed.searchad.errorCode, "NETWORK_ERROR");
  assert.equal(JSON.stringify(failed).includes("private-network-message"), false);
  const g = await fixture(t, { fetchImpl: () => ({ status: 200, text: async () => "x".repeat(256 * 1024 + 1) }) });
  assert.equal((await g.service.verify("datalab")).datalab.errorCode, "INVALID_RESPONSE");
});

test("interrupted persisted claims and future-dated records are not reported as successful", async t => {
  const f = await fixture(t); await f.service.verify("datalab");
  const data = JSON.parse(await fs.readFile(f.filePath, "utf8"));
  data.providers.datalab.checkStatus = "checking"; data.providers.datalab.checkedAt = ""; data.providers.datalab.status = null; data.providers.datalab.errorCode = "CHECK_IN_PROGRESS";
  await fs.writeFile(f.filePath, JSON.stringify(data));
  const interrupted = await f.create().status(); assert.equal(interrupted.datalab.checkStatus, "unknown"); assert.equal(interrupted.datalab.errorCode, "CHECK_INTERRUPTED");
  f.state.now -= 1000; const future = await f.service.status(); assert.equal(future.datalab.errorCode, "CLOCK_SKEW"); assert.equal(future.datalab.ok, false);
});

function request(body = "", headers = {}) { const req = Readable.from(body ? [Buffer.from(body)] : []); req.headers = { host: "example.test", ...headers }; return req; }
const targetUrl = new URL("https://example.test/api/settings/traffic-keys/verify");
test("verification request parser accepts legacy empty body and explicit service selections", async () => {
  assert.equal(await parseTrafficVerificationRequest(request(), targetUrl), "all");
  for (const provider of ["datalab", "searchad", "all"]) assert.equal(await parseTrafficVerificationRequest(request(JSON.stringify({ provider }), { "content-type": "application/json", origin: "https://example.test" }), targetUrl), provider);
});

test("verification request parser rejects invalid targets, bodies, origins and content types before probes", async () => {
  for (const body of ['{"provider":"other"}', '{"provider":"datalab","key":"not-allowed"}', "[]", "null", '"all"', "{"]) {
    await assert.rejects(parseTrafficVerificationRequest(request(body, { "content-type": "application/json" }), targetUrl), { statusCode: 400 });
  }
  await assert.rejects(parseTrafficVerificationRequest(request("{}"), targetUrl), { statusCode: 415 });
  await assert.rejects(parseTrafficVerificationRequest(request("{}", { "content-type": "text/plain" }), targetUrl), { statusCode: 415 });
  await assert.rejects(parseTrafficVerificationRequest(request("{}", { "content-type": "application/json", origin: "https://evil.test" }), targetUrl), { statusCode: 403 });
  await assert.rejects(parseTrafficVerificationRequest(request("{}", { "content-type": "application/json", origin: "null" }), targetUrl), { statusCode: 403 });
  await assert.rejects(parseTrafficVerificationRequest(request("x".repeat(513), { "content-type": "application/json" }), targetUrl), { statusCode: 413 });
  await assert.rejects(parseTrafficVerificationRequest(request("", { "content-length": "999999" }), targetUrl), { statusCode: 413 });
  await assert.rejects(parseTrafficVerificationRequest(request(), new URL(targetUrl.href + "?provider=datalab")), { statusCode: 400 });
});

test("actual server verification route enforces administrator access, validated payload, rate admission and safe errors", async () => {
  const source = await fs.readFile(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
  const start = source.indexOf('    if (req.method === "POST" && reqUrl.pathname === "/api/settings/traffic-keys/verify")');
  const end = source.indexOf("    const diagnosticsMatch", start); assert.ok(start > 0 && end > start);
  let admitted = 0, performed = [], allow = true, throwPrivate = false;
  const handler = new Function("requireAdminSession", "parseTrafficVerificationRequest", "assertRequestRateLimit", "RATE_LIMIT_POLICIES", "verifyTrafficKeys", "send", `return async function(req,res,reqUrl,session){${source.slice(start, end)}}`)(
    () => allow, parseTrafficVerificationRequest, () => { admitted++; }, { adminTrafficVerification: { limit: 12 } },
    async provider => { performed.push(provider); if (throwPrivate) throw new Error("private-route-error"); return { verification: { datalab: { ok: true } } }; },
    (res, status, payload) => ({ status, payload }));
  const make = body => { const req = request(body, body ? { "content-type": "application/json" } : {}); req.method = "POST"; return req; };
  allow = false; assert.equal(await handler(make('{"provider":"datalab"}'), {}, targetUrl, {}), undefined); assert.equal(performed.length, 0);
  allow = true; const success = await handler(make('{"provider":"datalab"}'), {}, targetUrl, { username: "test-admin" });
  assert.equal(success.status, 200); assert.deepEqual(performed, ["datalab"]); assert.equal(admitted, 1);
  const invalid = await handler(make('{"provider":"bad"}'), {}, targetUrl, { username: "test-admin" }); assert.equal(invalid.status, 400); assert.equal(performed.length, 1);
  throwPrivate = true; const failed = await handler(make(""), {}, targetUrl, { username: "test-admin" });
  assert.equal(failed.status, 503); assert.equal(JSON.stringify(failed).includes("private-route-error"), false);
});
