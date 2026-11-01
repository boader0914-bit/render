"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), zlib = require("node:zlib");
const { buildPreflightPlan, executePreflight, parseArguments, FILES } = require("./search_demand_preflight.cjs");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const KEYS = { datalabProvider: "ncp_apihub", ncpApihubClientId: "DUMMY-NCP-ID", ncpApihubClientSecret: "DUMMY-NCP-SECRET", searchadApiKey: "DUMMY-AD-ID", searchadSecretKey: "DUMMY-AD-SECRET", searchadCustomerId: "DUMMY-CUSTOMER" };
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "search-demand-preflight-test-"));
  t.after(async () => { assert.ok(path.resolve(parent).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(parent, { recursive: true, force: true }); });
  const operationRoot = path.join(parent, "operations", "search-demand-release-fixture"), sourceRoot = path.resolve(__dirname, "../.."), keyFile = path.join(parent, "config", "traffic_api_keys.local.json");
  await fs.mkdir(path.dirname(keyFile), { recursive: true }); await fs.writeFile(keyFile, JSON.stringify(KEYS));
  const plan = await buildPreflightPlan({ sourceRoot, operationRoot, keyFile });
  for (const relative of FILES) { const file = path.join(plan.codeRoot, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.copyFile(path.join(sourceRoot, relative), file); }
  const planFile = path.join(operationRoot, "plan.json"), raw = Buffer.from(JSON.stringify(plan)); await fs.writeFile(planFile, raw);
  const state = { calls: [], now: Date.parse("2026-11-02T00:10:00.000Z") };
  const fetchImpl = async (url, options) => {
    state.calls.push({ url, options });
    if (url.includes("searchad")) return new Response(JSON.stringify({ keywordList: [
      { relKeyword: "경남글램핑", monthlyPcQcCnt: 1790, monthlyMobileQcCnt: 7870 },
      { relKeyword: "경남글램핑", monthlyPcQcCnt: 1790, monthlyMobileQcCnt: 7870 },
      { relKeyword: "경남캠핑", monthlyPcQcCnt: "<10", monthlyMobileQcCnt: 20 },
      { relKeyword: "경남불멍", monthlyPcQcCnt: null, monthlyMobileQcCnt: 30 }
    ], ignored: "PRIVATE-PROVIDER-BODY" }), { status: 200 });
    const body = JSON.parse(options.body), data = [];
    for (let date = new Date(body.startDate + "T00:00:00Z"); date.toISOString().slice(0, 10) <= body.endDate; date.setUTCMonth(date.getUTCMonth() + 1)) data.push({ period: date.toISOString().slice(0, 10), ratio: data.length + 1 });
    return new Response(JSON.stringify({ ...body, results: [{ title: body.keywordGroups[0].groupName, keywords: body.keywordGroups[0].keywords, data }] }), { status: 200 });
  };
  const arguments_ = { planFile, planSha256: hash(raw), clock: () => state.now, fetchImpl, credentialEnvironment: {} };
  return { parent, operationRoot, keyFile, plan, state, arguments_, fetchImpl };
}

test("dry run verifies pinned pure sources without reading keys, writing results or contacting a provider", async t => {
  const f = await fixture(t); await fs.unlink(f.keyFile);
  const result = await executePreflight(f.arguments_);
  assert.equal(result.status, "ready_for_explicit_execution"); assert.equal(result.keySourceRead, false); assert.equal(f.state.calls.length, 0);
  await assert.rejects(fs.stat(path.join(f.operationRoot, "execution.claim.json")), { code: "ENOENT" });
});

test("two bounded fixture calls verify complete snapshots, duplicate reuse, all related rows and the saved forecast", async t => {
  const f = await fixture(t), result = await executePreflight({ ...f.arguments_, executeLive: true });
  assert.equal(result.status, "verified"); assert.equal(result.completionVerified, true); assert.equal(f.state.calls.length, 2);
  assert.deepEqual(result.requestCounts, { searchad: 1, datalab: 1 }); assert.equal(result.duplicateChecks.every(item => item.reused && item.createdOnDuplicate === false), true);
  assert.equal(result.searchad.counts.returnedRows, 4); assert.equal(result.searchad.counts.uniqueRows, 3); assert.equal(result.searchad.counts.partialKeys, 1);
  assert.equal(result.trend.coverage.observedMonths, 12); assert.equal(result.forecast.value, 805); assert.equal(result.forecast.published, true);
  const bytes = await fs.readFile(result.artifact.path); assert.equal(hash(bytes), result.artifact.sha256);
  const evidence = zlib.gunzipSync(bytes).toString("utf8"), publicText = JSON.stringify(result) + evidence;
  assert.equal(JSON.parse(evidence).normalized[0].rows.length, 4);
  for (const secret of Object.values(KEYS).filter(value => value !== "ncp_apihub")) assert.equal(publicText.includes(secret), false);
  assert.equal(publicText.includes("sdscope_"), false); assert.equal(publicText.includes("PRIVATE-PROVIDER-BODY"), false);
});

test("a completed rerun verifies the exact old evidence with no key read and no further request", async t => {
  const f = await fixture(t), first = await executePreflight({ ...f.arguments_, executeLive: true }); await fs.unlink(f.keyFile);
  const again = await executePreflight({ ...f.arguments_, executeLive: true, fetchImpl: async () => { throw new Error("MUST_NOT_FETCH"); } });
  assert.equal(again.reusedExistingEvidence, true); assert.deepEqual(again.newRequestCounts, { searchad: 0, datalab: 0 }); assert.equal(again.artifact.sha256, first.artifact.sha256);
});

test("a source SHA mismatch fails before credentials or requests", async t => {
  const f = await fixture(t); await fs.appendFile(path.join(f.plan.codeRoot, FILES[0]), "\n// changed\n"); await fs.unlink(f.keyFile);
  await assert.rejects(executePreflight({ ...f.arguments_, executeLive: true }), error => error.code === "PREFLIGHT_SOURCE_SHA_MISMATCH"); assert.equal(f.state.calls.length, 0);
});

test("an authentication failure stops before the second provider and is never retried", async t => {
  const f = await fixture(t); let calls = 0;
  const result = await executePreflight({ ...f.arguments_, executeLive: true, fetchImpl: async () => { calls++; return new Response("PRIVATE_AUTH_FAILURE", { status: 403 }); } });
  assert.equal(result.status, "needs_verification"); assert.equal(result.errorCode, "AUTH_ERROR"); assert.equal(calls, 1); assert.equal(result.requestCounts.datalab, 0);
  await executePreflight({ ...f.arguments_, executeLive: true, fetchImpl: async () => { calls++; throw new Error(); } }); assert.equal(calls, 1);
});

test("a429 at the trend stage preserves the first snapshot and sends no automatic retry", async t => {
  const f = await fixture(t); let calls = 0;
  const result = await executePreflight({ ...f.arguments_, executeLive: true, fetchImpl: async (url, options) => {
    calls++; return url.includes("searchad") ? f.fetchImpl(url, options) : new Response("PRIVATE_LIMIT_BODY", { status: 429 });
  } });
  assert.equal(result.status, "needs_verification"); assert.equal(result.errorCode, "QUOTA_EXCEEDED"); assert.equal(calls, 2); assert.equal(result.snapshotIds.length, 1);
  assert.equal(JSON.stringify(result).includes("PRIVATE_LIMIT_BODY"), false);
});

test("an interrupted claim blocks all requests without attempting credential recovery", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.operationRoot, "execution.claim.json"), JSON.stringify({ schemaVersion: 1, startedAt: "2026-11-02T00:00:00.000Z" })); await fs.unlink(f.keyFile);
  const result = await executePreflight({ ...f.arguments_, executeLive: true }); assert.equal(result.errorCode, "PREFLIGHT_EXISTING_CLAIM");
  assert.equal(f.state.calls.length, 0); assert.equal(result.previousRequestCounts, null);
});

test("named environment overrides use the server precedence without exposing any value", async t => {
  const f = await fixture(t);
  const expected = "DUMMY-EFFECTIVE-ID";
  const result = await executePreflight({ ...f.arguments_, executeLive: true, credentialEnvironment: { NAVER_SEARCHAD_API_KEY: expected }, fetchImpl: async (url, options) => {
    if (url.includes("searchad")) assert.equal(options.headers["X-API-KEY"], expected);
    return f.fetchImpl(url, options);
  } });
  assert.equal(result.status, "verified"); assert.equal(JSON.stringify(result).includes(expected), false);
});

test("a linked key-file parent is rejected before any request", async t => {
  const f = await fixture(t), config = path.dirname(f.keyFile), target = path.join(f.parent, "key-target");
  await fs.rename(config, target);
  try { await fs.symlink(target, config, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "ENOTSUP"].includes(error.code)) return t.skip("directory link unavailable"); throw error; }
  await assert.rejects(executePreflight({ ...f.arguments_, executeLive: true }), error => error.code === "PREFLIGHT_PATH_UNSAFE"); assert.equal(f.state.calls.length, 0);
});

test("CLI requires the pinned plan and rejects every unrelated override", () => {
  assert.deepEqual(parseArguments(["--plan", "/tmp/plan.json", "--plan-sha256", "a".repeat(64), "--execute-live"]), { executeLive: true, planFile: "/tmp/plan.json", planSha256: "a".repeat(64) });
  for (const arguments_ of [["--code-root", "/tmp"], ["--keyword", "다른키워드"], ["--execute-live", "--execute-live"]]) assert.throws(() => parseArguments(arguments_), error => error.code === "PREFLIGHT_ARGUMENT_INVALID");
});
