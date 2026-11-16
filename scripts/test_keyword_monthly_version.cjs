"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), vm = require("node:vm");
const { createKeywordMonthlyBundleAnalysis, KEYWORD_MONTHLY_BUNDLE_LIMITS } = require("./lib/keyword_monthly_bundle.cjs");
const { createKeywordMonthlyHttpHandler } = require("./lib/keyword_monthly_http.cjs");
const { createKeywordMonthlyQueryLifecycle } = require("./lib/keyword_monthly_query_lifecycle.cjs");
const NOW = "2026-11-15T15:01:00.000Z", digest = value => crypto.createHash("sha256").update(value).digest("hex");
const pointer = (extra = {}) => ({ schemaVersion: 1, generation: "a".repeat(32), catalogSha256: "b".repeat(64), catalogBytes: 321,
  publishedAt: "2026-11-15T15:00:00.000Z", ...extra });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-version-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, "current.json"), bytes = Buffer.from(JSON.stringify(pointer())); await fs.writeFile(file, bytes);
  const service = createKeywordMonthlyBundleAnalysis({ projectionDir: root, now: () => NOW,
    measure: async () => { throw Error("A version notification cannot enter analysis measurement"); },
    runLegacyAnalysis: async () => { throw Error("A version notification cannot run legacy analysis"); } });
  return { root, file, bytes, service };
}

test("version reads only the bounded pointer twice and never certifies catalog, results or original freshness", async t => {
  const f = await fixture(t), open = fs.open, reads = [];
  fs.open = async (file, ...args) => { reads.push(path.resolve(file)); assert.equal(path.resolve(file), f.file); return open.call(fs, file, ...args); };
  let result; try { result = await f.service.version(); } finally { fs.open = open; }
  assert.deepEqual(reads, [f.file, f.file]); assert.deepEqual(result, { schemaVersion: 1, currentDay: "2026-11-16", readOnly: true,
    networkAttempted: false, originalFreshnessVerified: false, status: "available", revision: digest(f.bytes), generation: pointer().generation, publishedAt: pointer().publishedAt });
  assert.deepEqual(await fs.readFile(f.file), f.bytes); assert.deepEqual(await fs.readdir(f.root), ["current.json"]);
  assert.equal(Object.hasOwn(result, "snapshot"), false); assert.equal(Object.hasOwn(result, "sourceRevalidated"), false);
});

test("restart preserves the version and an atomic publication changes it without caching or source reads", async t => {
  const f = await fixture(t), first = await f.service.version();
  const restarted = createKeywordMonthlyBundleAnalysis({ projectionDir: f.root, now: () => NOW }); assert.deepEqual(await restarted.version(), first);
  const next = Buffer.from(JSON.stringify(pointer({ generation: "c".repeat(32), catalogSha256: "d".repeat(64) })));
  const temporary = path.join(f.root, "next-pointer.json"); await fs.writeFile(temporary, next); await fs.rename(temporary, f.file);
  const second = await f.service.version(); assert.equal(second.status, "available"); assert.equal(second.revision, digest(next));
  assert.notEqual(second.revision, first.revision); assert.equal(second.generation, "c".repeat(32)); assert.equal(second.originalFreshnessVerified, false);
});

test("missing, malformed, oversized and multiply linked pointers never advertise an available version", async t => {
  const f = await fixture(t);
  await fs.unlink(f.file); let result = await f.service.version(); assert.equal(result.status, "needs_verification"); assert.equal(result.revision, null);
  assert.deepEqual(result.diagnostics, ["KEYWORD_MONTHLY_BUNDLE_POINTER_MISSING"]);
  for (const contents of ["{", JSON.stringify({ ...pointer(), generation: "../escape" }), JSON.stringify({ ...pointer(), unexpected: true }),
    "x".repeat(KEYWORD_MONTHLY_BUNDLE_LIMITS.pointerBytes + 1)]) {
    await fs.writeFile(f.file, contents); result = await f.service.version();
    assert.equal(result.status, "needs_verification"); assert.equal(result.revision, null); assert.equal(result.originalFreshnessVerified, false);
  }
  await fs.writeFile(f.file, f.bytes); const alias = path.join(f.root, "pointer-alias.json"); await fs.link(f.file, alias);
  result = await f.service.version(); assert.equal(result.status, "needs_verification"); assert.equal(result.revision, null);
  assert.deepEqual(result.diagnostics, ["KEYWORD_MONTHLY_BUNDLE_UNSAFE_PATH"]);
});

test("publication between the two pointer reads is held rather than adopting mixed versions", async t => {
  const f = await fixture(t), open = fs.open; let changed = false;
  fs.open = async function (file, ...args) {
    const handle = await open.call(fs, file, ...args);
    if (path.resolve(file) === f.file && !changed) {
      const close = handle.close.bind(handle); handle.close = async () => {
        await close(); if (changed) return; changed = true;
        const next = path.join(f.root, "race-pointer.json"); await fs.writeFile(next, JSON.stringify(pointer({ generation: "c".repeat(32) })));
        await fs.rename(next, f.file);
      };
    }
    return handle;
  };
  let result; try { result = await f.service.version(); } finally { fs.open = open; }
  assert.equal(changed, true); assert.equal(result.status, "needs_verification"); assert.equal(result.revision, null);
  assert.deepEqual(result.diagnostics, ["KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ"]);
});

function httpFixture({ authorized = true, version = async () => ({ status: "available", revision: "a".repeat(64), originalFreshnessVerified: false }) } = {}) {
  const calls = [], statusCalls = [], queryCalls = [], budgetCalls = [];
  const service = { options: async () => { throw Error("Not a version read"); }, analyze: async () => { throw Error("Not a version read"); } };
  if (version !== null) service.version = async () => { calls.push("version"); return version(); };
  const lifecycle = records => ({ run: async (identity, operation) => { records.push(identity); return operation(); }, status: () => ({}) });
  const handler = createKeywordMonthlyHttpHandler({ service, requireAdmin: () => authorized, queryLifecycle: lifecycle(queryCalls), statusLifecycle: lifecycle(statusCalls),
    responseBudget: { run: async () => { throw Error("A version read cannot reserve the result budget"); } },
    statusResponseBudget: { run: async (res, operation) => { budgetCalls.push("status"); await operation({ nativeResponse: false }); } },
    readRefreshStatus: async () => { throw Error("A version read cannot inspect refresh work"); },
    send: (res, status, body) => Object.assign(res, { status, body }) });
  return { calls, statusCalls, queryCalls, budgetCalls, async run(route = "/api/keyword-monthly/version", method = "GET") {
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; } };
    const handled = await handler({ method }, res, new URL(route, "https://example.test"), {}); return { ...res, handled };
  } };
}

test("HTTP version is authenticated, GET only, parameter free and uses the separate status lifecycle and budget", async () => {
  const f = httpFixture(), result = await f.run(); assert.equal(result.status, 200); assert.equal(result.body.originalFreshnessVerified, false);
  assert.deepEqual(f.calls, ["version"]); assert.deepEqual(f.statusCalls, ["version"]); assert.deepEqual(f.queryCalls, []); assert.deepEqual(f.budgetCalls, ["status"]);
  assert.equal(result.headers["Cache-Control"], "private, no-store"); assert.equal(result.headers.Vary, "Cookie");
  const blocked = httpFixture({ authorized: false }); assert.equal((await blocked.run()).handled, true); assert.deepEqual(blocked.calls, []);
  const invalid = httpFixture();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) assert.equal((await invalid.run(undefined, method)).status, 405);
  for (const query of ["?force=1", "?keyword=a", "?revision=", "?a=1&a=2"]) assert.equal((await invalid.run("/api/keyword-monthly/version" + query)).status, 400);
  assert.deepEqual(invalid.calls, []); assert.deepEqual(invalid.statusCalls, []);
});

test("HTTP absent version support, unavailable pointers and read failures fail safely without claiming freshness", async () => {
  const missing = await httpFixture({ version: null }).run(); assert.equal(missing.status, 503); assert.equal(missing.body.code, "KEYWORD_MONTHLY_VERSION_UNAVAILABLE");
  const unavailable = await httpFixture({ version: async () => ({ status: "needs_verification", revision: null, originalFreshnessVerified: false }) }).run();
  assert.equal(unavailable.status, 503); assert.equal(unavailable.body.revision, null); assert.equal(unavailable.body.originalFreshnessVerified, false);
  const failed = await httpFixture({ version: async () => { throw Error("private source path and secret"); } }).run();
  assert.equal(failed.status, 503); assert.equal(failed.body.status, "needs_verification"); assert.equal(JSON.stringify(failed.body).includes("secret"), false);
});

test("the application version wrapper bypasses the analytical lease while preserving the existing heavy wrappers", async () => {
  const source = await fs.readFile(path.join(__dirname, "glamping_app_server.cjs"), "utf8"), declaration = source.match(/const keywordMonthlyAnalysis = Object\.freeze\(\{[\s\S]*?\n\}\);/);
  assert.ok(declaration); let reads = 0;
  const sentinel = { status: "available", revision: "a".repeat(64) }, context = vm.createContext({
    keywordMonthlyPreparedAnalysis: { version: async () => { reads++; return sentinel; } },
    runAnalyticalWork: () => { throw Error("Version notification cannot acquire the analytical lease"); }
  });
  const service = new vm.Script(declaration[0] + "\nkeywordMonthlyAnalysis").runInContext(context);
  assert.equal(await service.version(), sentinel); assert.equal(reads, 1); assert.equal(typeof service.options, "function"); assert.equal(typeof service.analyze, "function");
});

function dataHttpFixture({ readPrepared = async input => ({ status: "available", mode: "prepared", request: input }),
  analyze = async input => ({ status: "available", mode: "analyze", request: input }), queryLifecycle = createKeywordMonthlyQueryLifecycle() } = {}) {
  const calls = [], service = { options: async () => { throw Error("No options read"); }, analyze: async input => { calls.push("analyze"); return analyze(input); } };
  if (readPrepared !== null) service.readPrepared = async input => { calls.push("prepared"); return readPrepared(input); };
  const handler = createKeywordMonthlyHttpHandler({ service, queryLifecycle, requireAdmin: () => true,
    send: (res, status, body) => Object.assign(res, { status, body }) });
  return { calls, queryLifecycle, async run(headers = {}) {
    const res = { setHeader() {} }; await handler({ method: "GET", headers }, res,
      new URL("https://example.test/api/keyword-monthly?keyword=fixture&month=2026-11&cutoffDate=2026-11-15"), {}); return res;
  } };
}

test("automatic prepared-only reads cannot invoke legacy analysis while ordinary manual reads retain it", async () => {
  const f = dataHttpFixture(), manual = await f.run(), automatic = await f.run({ "x-keyword-monthly-prepared-only": "1" });
  assert.equal(manual.body.mode, "analyze"); assert.equal(automatic.body.mode, "prepared"); assert.deepEqual(f.calls, ["analyze", "prepared"]);
  assert.deepEqual(automatic.body.request, manual.body.request);
  const missing = dataHttpFixture({ readPrepared: async () => ({ status: "missing", snapshot: null, preparedResult: { status: "not_prepared" } }),
    analyze: async () => { throw Error("A missing prepared result cannot fall back to analysis"); } });
  const held = await missing.run({ "x-keyword-monthly-prepared-only": "1" }); assert.equal(held.body.snapshot, null); assert.deepEqual(missing.calls, ["prepared"]);
});

test("unsupported prepared-only reads fail503 and malformed mode headers fail400 without invoking either reader", async () => {
  const unsupported = dataHttpFixture({ readPrepared: null }), result = await unsupported.run({ "x-keyword-monthly-prepared-only": "1" });
  assert.equal(result.status, 503); assert.equal(result.body.code, "KEYWORD_MONTHLY_PREPARED_READ_UNAVAILABLE"); assert.deepEqual(unsupported.calls, []);
  const invalid = dataHttpFixture();
  for (const value of ["", "0", "true", "01", " 1", "1,1", 1, undefined, ["1"]]) {
    const response = await invalid.run({ "x-keyword-monthly-prepared-only": value });
    assert.equal(response.status, 400); assert.equal(response.body.code, "KEYWORD_MONTHLY_INVALID_REQUEST");
  }
  assert.deepEqual(invalid.calls, []);
});

test("identical automatic requests share a flight but never join an unfinished manual analysis of the same query", async () => {
  let finishManual, finishPrepared;
  const manual = new Promise(resolve => { finishManual = resolve; }), prepared = new Promise(resolve => { finishPrepared = resolve; });
  const f = dataHttpFixture({ analyze: () => manual, readPrepared: () => prepared }), first = f.run();
  await new Promise(setImmediate);
  const second = f.run({ "x-keyword-monthly-prepared-only": "1" }), third = f.run({ "x-keyword-monthly-prepared-only": "1" });
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, ["analyze", "prepared"]); assert.equal(f.queryLifecycle.status().inFlight, 2);
  assert.equal(f.queryLifecycle.status().counters.shared, 1);
  finishPrepared({ status: "available", mode: "prepared" });
  for (const result of await Promise.all([second, third])) assert.equal(result.body.mode, "prepared");
  assert.equal(f.queryLifecycle.status().inFlight, 1);
  finishManual({ status: "available", mode: "analyze" }); assert.equal((await first).body.mode, "analyze"); assert.equal(f.queryLifecycle.status().inFlight, 0);
});

test("the application prepared-only wrapper keeps the existing allocation lease and never calls the analysis fallback", async () => {
  const source = await fs.readFile(path.join(__dirname, "glamping_app_server.cjs"), "utf8"), declaration = source.match(/const keywordMonthlyAnalysis = Object\.freeze\(\{[\s\S]*?\n\}\);/);
  assert.ok(declaration); const calls = [], input = { keyword: "fixture", month: "2026-11" }, sentinel = { status: "missing", snapshot: null };
  const context = vm.createContext({ keywordMonthlyPreparedAnalysis: { readPrepared: async value => { assert.equal(value, input); calls.push("prepared"); return sentinel; },
    analyze: () => { throw Error("No legacy analysis"); } }, runAnalyticalWork: (operation, options) => { calls.push(options.kind); return operation(); } });
  const service = new vm.Script(declaration[0] + "\nkeywordMonthlyAnalysis").runInContext(context);
  assert.equal(await service.readPrepared(input), sentinel); assert.deepEqual(calls, ["keyword_monthly_analysis", "prepared"]);
});
