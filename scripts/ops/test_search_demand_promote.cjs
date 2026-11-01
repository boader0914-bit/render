"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { executePromotion, parseArguments, FILES } = require("./search_demand_promote.cjs");
const M = require("../lib/search_demand_model.cjs"), { createSearchDemandStore } = require("../lib/search_demand_store.cjs"), { buildSearchDemandForecast } = require("../lib/search_demand_forecast.cjs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "search-demand-promote-"));
  t.after(async () => { assert.ok(path.resolve(parent).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(parent, { recursive: true, force: true }); });
  const operationRoot = path.join(parent, "operations"), productionRoot = path.join(parent, "production"), sourceRoot = path.resolve(__dirname, "../.."), codeRoot = path.join(operationRoot, "code");
  const keyword = "경남글램핑", observedAt = "2026-11-02T00:10:00.000Z", requestedAt = "2026-11-02T00:09:00.000Z", state = { now: Date.parse("2026-11-02T00:11:00.000Z") }, scope = "sdscope_" + "a".repeat(64);
  const search = M.normalizeSearchAdSnapshot({ keyword, observedAt, scopeId: scope, keywordList: [{ relKeyword: keyword, monthlyPcQcCnt: 1000, monthlyMobileQcCnt: 2000 },
    ...Array.from({ length: 860 }, (_, i) => ({ relKeyword: "연관검증" + i, monthlyPcQcCnt: i === 0 ? "<10" : i, monthlyMobileQcCnt: i === 1 ? null : 10 }))] });
  const trend = M.normalizeTrendSnapshot({ keyword, observedAt, scopeId: scope, connectionProvider: "ncp_apihub", startDate: "2025-11-01", endDate: "2026-10-31", timeUnit: "month",
    results: [{ title: keyword, keywords: [keyword], data: Array.from({ length: 12 }, (_, i) => ({ period: new Date(Date.UTC(2025, 10 + i, 1)).toISOString().slice(0, 10), ratio: i + 10 })) }] });
  const snapshots = [search, trend], files = [];
  for (const relative of FILES) { const bytes = await fs.readFile(path.join(sourceRoot, relative)), target = path.join(codeRoot, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) }); }
  const plan = { schemaVersion: 1, purpose: "gyeongnam-search-demand-release-preflight", keyword, operationRoot, codeRoot, keyFile: path.join(parent, "never-read", "traffic_api_keys.local.json"), credentialMode: "effective",
    requestWindow: { startDate: "2025-11-01", endDate: "2026-10-31", timeUnit: "month", expectedMonths: 12 }, expectedRequests: { searchad: 1, datalab: 1 }, connectionProvider: "ncp_apihub", files };
  const planFile = path.join(operationRoot, "plan.json"), bytes = Buffer.from(JSON.stringify(plan)); await fs.writeFile(planFile, bytes);
  const planSha256 = hash(bytes), clock = () => state.now, store = createSearchDemandStore({ rootDir: path.join(operationRoot, "validation-store"), clock });
  for (const snapshot of snapshots) await store.saveSnapshot(snapshot);
  const forecast = buildSearchDemandForecast({ keyword, searchSnapshot: search, trendSnapshot: trend, targetMonth: "2026-11", calculatedAt: observedAt }); await store.saveForecast(forecast);
  const receipt = { schemaVersion: 1, status: "verified", completionVerified: true, keyword, planSha256, startedAt: requestedAt, finishedAt: observedAt,
    requestCounts: { searchad: 1, datalab: 1 }, automaticRetries: false, connectionProvider: "ncp_apihub", results: snapshots.map(snapshot => ({ provider: snapshot.provider, status: "complete", errorCode: null,
      requestCount: 1, networkAttempted: true, snapshotId: snapshot.snapshotId, requestedAt, observedAt })), errorCode: null, snapshotIds: snapshots.map(snapshot => snapshot.snapshotId),
    duplicateChecks: snapshots.map(snapshot => ({ provider: snapshot.provider, snapshotId: snapshot.snapshotId, reused: true, createdOnDuplicate: false })), sourcePins: files,
    credentialValuesExposed: false, collectionScheduleChanged: false, protectionReleased: false, kosisRead: false, applicationStarted: false, forecast: { ...forecast, published: true } };
  const receiptFile = path.join(operationRoot, "execution-result.json"); await fs.writeFile(receiptFile, JSON.stringify(receipt));
  const args = { planFile, planSha256, clock }, fixtureOptions = { fixtureOnly: true, operationRoot, productionRoot, sourceRoot, planSha256, expectedSnapshotIds: receipt.snapshotIds };
  return { parent, operationRoot, productionRoot, sourceRoot, planFile, receiptFile, plan, receipt, state, snapshots, store, args, fixtureOptions };
}
async function footprint(root) {
  try { const output = {}; for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = path.join(entry.parentPath || entry.path, entry.name), stat = await fs.stat(file); output[path.relative(root, file)] = [stat.size, stat.mtimeMs, hash(await fs.readFile(file))];
  } return output; } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}
const promote = f => executePromotion({ ...f.args, executeApproved: true }, f.fixtureOptions);
test("dry verification reads no key file and creates no production data, policy or claim", async t => {
  const f = await fixture(t), before = await footprint(f.parent), result = await executePromotion(f.args, f.fixtureOptions);
  assert.equal(result.status, "ready_for_explicit_promotion"); assert.equal(result.operatingWrites, false); assert.equal(result.providerCalls, 0);
  assert.deepEqual(await footprint(f.parent), before); await assert.rejects(fs.stat(f.productionRoot), { code: "ENOENT" });
});
test("promotes both exact full snapshots, preserves partial counters, publishes once and activates last", async t => {
  const f = await fixture(t), result = await promote(f); assert.equal(result.status, "verified"); assert.equal(result.completionVerified, true);
  assert.deepEqual(result.writes, { snapshotsCreated: 2, forecastCreated: true, activationCreated: true }); assert.equal(result.providerCalls, 0); assert.equal(result.apiCalls, 0);
  const production = createSearchDemandStore({ rootDir: f.productionRoot }), search = await production.readSnapshot({ snapshotId: f.snapshots[0].snapshotId });
  assert.equal(search.rows.length, 861); assert.equal(search.observations.length, 861); assert.equal(search.observations[1].monthlyPc.state, "range"); assert.equal(search.observations[2].monthlyMobile.state, "unknown");
  const forecast = await production.listForecasts({ keyword: f.plan.keyword, month: "2026-11" }); assert.equal(forecast.total, 1); assert.deepEqual(forecast.rows[0].sourceSnapshotIds, f.receipt.snapshotIds);
  const policy = JSON.parse(await fs.readFile(path.join(f.productionRoot, "activation.json"), "utf8"));
  assert.deepEqual(Object.keys(policy).sort(), ["approvedAt", "enabled", "notBeforeDay", "scheduleVersion"]); assert.equal(policy.notBeforeDay, "2026-11-02"); assert.equal(policy.approvedAt, new Date(f.state.now).toISOString());
  const output = JSON.stringify(result); assert.equal(output.includes("sdscope_"), false); assert.equal(output.includes("keyFile"), false); assert.equal(output.includes("leaseHash"), false);
});
test("same approved rerun retains all data and forecast bytes without keys or new API requests", async t => {
  const f = await fixture(t); await promote(f); const before = await footprint(f.parent); f.state.now += 60000;
  const result = await promote(f); assert.equal(result.reusedExistingPromotion, true); assert.deepEqual(result.writes, { snapshotsCreated: 0, forecastCreated: false, activationCreated: false });
  assert.deepEqual(await footprint(f.parent), before); assert.deepEqual(result.newRequestCounts, { searchad: 0, datalab: 0 });
});
test("different existing activation policy stops before any data write and is never overwritten", async t => {
  const f = await fixture(t); await fs.mkdir(f.productionRoot); await fs.writeFile(path.join(f.productionRoot, "activation.json"), JSON.stringify({ enabled: false, approvedAt: "2026-11-02T00:00:00.000Z", notBeforeDay: "2026-11-02", scheduleVersion: "search-demand-schedule-v1" }));
  const before = await footprint(f.parent); await assert.rejects(promote(f), { code: "SEARCH_DEMAND_PROMOTION_POLICY_CONFLICT" }); assert.deepEqual(await footprint(f.parent), before);
});
test("an existing matching activation with absent data is held rather than silently repaired", async t => {
  const f = await fixture(t); await fs.mkdir(f.productionRoot); await fs.writeFile(path.join(f.productionRoot, "activation.json"), JSON.stringify({ enabled: true, approvedAt: "2026-11-02T00:00:00.000Z", notBeforeDay: "2026-11-02", scheduleVersion: "search-demand-schedule-v1" }));
  const before = await footprint(f.parent); await assert.rejects(promote(f), { code: "SEARCH_DEMAND_PROMOTION_ACTIVE_DATA_MISSING" }); assert.deepEqual(await footprint(f.parent), before);
});
test("stale, partial, wrong-count and mismatched-source receipts fail before production writes", async t => {
  for (const change of [r => r.completionVerified = false, r => r.status = "partial", r => r.requestCounts.searchad = 2, r => r.snapshotIds.reverse(), r => r.sourcePins[0].sha256 = "a".repeat(64),
    r => r.finishedAt = "2026-11-01T00:10:00.000Z", r => r.results[0].requestCount = null]) {
    const f = await fixture(t); change(f.receipt); await fs.writeFile(f.receiptFile, JSON.stringify(f.receipt));
    await assert.rejects(promote(f), { code: "SEARCH_DEMAND_PROMOTION_RECEIPT_UNVERIFIED" }); assert.deepEqual(await footprint(f.productionRoot), {});
  }
});
test("missing exact source data and frozen or deployed code changes do not fall back to other files", async t => {
  const f = await fixture(t); await fs.unlink(path.join(f.operationRoot, "validation-store", "snapshots", f.snapshots[0].snapshotId + ".json"));
  await assert.rejects(promote(f)); assert.deepEqual(await footprint(f.productionRoot), {});
  const g = await fixture(t); await fs.appendFile(path.join(g.plan.codeRoot, FILES[0]), "\n// changed\n");
  await assert.rejects(promote(g), { code: "SEARCH_DEMAND_PROMOTION_SOURCE_SHA_MISMATCH" }); assert.deepEqual(await footprint(g.productionRoot), {});
});
test("no old lock takeover and no duplicate forecast publication during overlapping promotion", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.operationRoot, "promotion.lock.json"), JSON.stringify({ schemaVersion: 1, owner: "old-owner", planSha256: f.args.planSha256, startedAt: "2020-01-01T00:00:00.000Z" }));
  const before = await footprint(f.parent); await assert.rejects(promote(f), { code: "SEARCH_DEMAND_PROMOTION_EXISTING_LOCK_REVIEW_REQUIRED" }); assert.deepEqual(await footprint(f.parent), before);
  const g = await fixture(t), results = await Promise.allSettled([promote(g), promote(g)]); assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const production = createSearchDemandStore({ rootDir: g.productionRoot }); assert.equal((await production.listForecasts({ keyword: g.plan.keyword })).total, 1);
});
test("linked production parent is rejected without opening or writing outside the namespace", async t => {
  const f = await fixture(t), outside = path.join(f.parent, "outside"); await fs.mkdir(outside);
  try { await fs.symlink(outside, f.productionRoot, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "ENOTSUP"].includes(error.code)) return t.skip("directory link creation unavailable"); throw error; }
  await assert.rejects(promote(f), { code: "SEARCH_DEMAND_PROMOTION_PATH_UNSAFE" }); assert.deepEqual(await fs.readdir(outside), []);
});
test("hardlinked and oversized receipts fail closed before production data is created", async t => {
  const f = await fixture(t); await fs.link(f.receiptFile, path.join(f.parent, "linked-receipt.json"));
  await assert.rejects(promote(f), { code: "SEARCH_DEMAND_PROMOTION_FILE_UNSAFE" }); assert.deepEqual(await footprint(f.productionRoot), {});
  const g = await fixture(t); await fs.writeFile(g.receiptFile, " ".repeat(65537));
  await assert.rejects(promote(g), { code: "SEARCH_DEMAND_PROMOTION_FILE_UNSAFE" }); assert.deepEqual(await footprint(g.productionRoot), {});
});
test("same policy cannot conceal a missing persisted forecast", async t => {
  const f = await fixture(t); await promote(f);
  const catalogFile = path.join(f.productionRoot, "index", "catalog.json"), catalog = JSON.parse(await fs.readFile(catalogFile, "utf8")); catalog.forecasts = [];
  await fs.writeFile(catalogFile, JSON.stringify(catalog)); const before = await footprint(f.parent);
  await assert.rejects(promote(f), { code: "SEARCH_DEMAND_PROMOTION_FORECAST_BINDING_UNVERIFIED" }); assert.deepEqual(await footprint(f.parent), before);
});
test("a failed snapshot write cannot activate a partially promoted store", async t => {
  const f = await fixture(t); const open = fs.open;
  t.mock.method(fs, "open", async function (file, ...args) {
    if (String(file) === path.join(f.productionRoot, "snapshots", f.snapshots[1].snapshotId + ".json")) throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
    return open.call(this, file, ...args);
  });
  await assert.rejects(promote(f)); await assert.rejects(fs.stat(path.join(f.productionRoot, "activation.json")), { code: "ENOENT" });
  const first = createSearchDemandStore({ rootDir: f.productionRoot }); assert.ok(await first.readSnapshot({ snapshotId: f.snapshots[0].snapshotId }));
});
test("crossing KST midnight after snapshot writes blocks activation and preserves the stored copies", async t => {
  const f = await fixture(t); let reads = 0; const lstat = fs.lstat;
  t.mock.method(fs, "lstat", async function (file, ...args) { if (String(file) === f.receiptFile && ++reads >= 3) f.state.now += 86400000; return lstat(file, ...args); });
  await assert.rejects(promote(f)); await assert.rejects(fs.stat(path.join(f.productionRoot, "activation.json")), { code: "ENOENT" });
});
test("CLI has no root, keyword, credentials, provider or clock override", () => {
  assert.deepEqual(parseArguments(["--execute-approved", "--plan", "/tmp/plan.json", "--plan-sha256", "a".repeat(64)]), { executeApproved: true, planFile: "/tmp/plan.json", planSha256: "a".repeat(64) });
  for (const args of [["--execute-approved", "--execute-approved"], ["--production-root", "/tmp"], ["--fetch", "x"], ["--now", "2026-11-02"]]) assert.throws(() => parseArguments(args), { code: "SEARCH_DEMAND_PROMOTION_ARGUMENT_INVALID" });
});
