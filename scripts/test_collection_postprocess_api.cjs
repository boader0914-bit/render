"use strict";

// Synthetic saved artifacts only: the child guard rejects provider/network and
// crawler subprocess calls. No operating data, credentials or external API is used.
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createCollectionPostprocessQueue } = require("./lib/collection_postprocess_queue.cjs");
const { inspectManifest } = require("./daily_collection_quality.cjs");
const { freePort, request, jsonPost, login, waitUntil, writeMockArtifacts, stopChild, executionGuard } = require("./test_collector_integration.cjs");
const ROOT = path.resolve(__dirname, "..");
const ADMIN = { username: "postprocess-admin", password: "fixture-postprocess-admin-password" };
const MEMBER = { username: "postprocess-member", password: "fixture-postprocess-member-password" };
const PRIVATE_CONTEXT = "PRIVATE_POSTPROCESS_CONTEXT_NOT_FOR_HTTP";
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

async function scenario(temporary, corrupt) {
  const dataDir = path.join(temporary, corrupt ? "corrupt-data" : "normal-data"), outputsDir = path.join(dataDir, "outputs"), configDir = path.join(dataDir, "config");
  await fs.mkdir(configDir, { recursive: true });
  const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const checkout = new Date(Date.parse(day + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  const finishedAt = new Date().toISOString(), startedAt = new Date(Date.now() - 2000).toISOString();
  const plan = { keyword: "후처리검증글램핑", checkIn: day, checkOut: checkout, adults: 2, searchMode: "keyword", searchScope: "all_lodging", workerKey: "manual", trigger: "manual",
    collectionMode: "precision", collectionPurpose: "revenue_detail", detailRankRanges: "1-1", productMode: "all", dayUseMode: "inspect", bookingRangeDays: 1, bookingRangePlaceLimit: 1 };
  const artifact = await writeMockArtifacts({ OUTPUTS_DIR: outputsDir, CHECK_IN: day, CHECK_OUT: checkout, ADULTS: 2, SEARCH_MODE: "keyword",
    COLLECTION_MODE: "precision", COLLECTION_PURPOSE: "revenue_detail", PRODUCT_MODE: "all", DAY_USE_MODE: "inspect", BOOKING_RANGE_DAYS: 1,
    BOOKING_RANGE_PLACE_LIMIT: 1, DETAIL_RANK_RANGES: "1-1", COLLECTOR_WORKER_KEY: "manual", COLLECTOR_TRIGGER: "manual",
    COLLECTOR_JOB_ID: "collector_00000000-0000-4000-8000-000000000001", COLLECTOR_ENGINE: "current-manual-v2", COLLECTOR_RUN_TOKEN: "a".repeat(24) }, plan.keyword, corrupt ? 42 : 41, false);
  const manifestFile = path.join(artifact.runDir, "manifest.json"), manifest = JSON.parse(await fs.readFile(manifestFile));
  Object.assign(manifest, plan, { startedAt, collectedAt: finishedAt, sourceRole: "admin", collectionSource: "admin_search" });
  manifest.collectionQuality = inspectManifest(manifest, plan);
  assert.equal(manifest.collectionQuality.status, "complete", "synthetic source passes the actual completion inspector");
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const sourceHashes = Object.fromEntries(await Promise.all(["manifest.json", artifact.csv].map(async name => [name, sha(await fs.readFile(path.join(artifact.runDir, name)))])));
  const queue = createCollectionPostprocessQueue({ dataDir: path.join(dataDir, "history"), processRun: async () => { throw Error("Parent fixture must not process"); } });
  if (corrupt) {
    await fs.mkdir(path.dirname(queue.stateFile), { recursive: true });
    await fs.writeFile(queue.stateFile, '{"version":1,"jobs":');
  } else {
    await queue.enqueue(artifact.runId, { context: { plan, estimate: {}, startedAt, endedAt: finishedAt, stageTimings: [],
      collectionSource: "admin_search", sourceRole: "admin", workerKey: "manual", trigger: "manual", scheduleOccurrenceId: null,
      manifestSha256: sourceHashes["manifest.json"], b2bSubscribers: [] } });
    await queue.enqueue("fixture_private_held", { deferred: true, context: { note: PRIVATE_CONTEXT, b2bSubscribers: [{ memberId: "PRIVATE_MEMBER_CONTEXT" }] } });
  }
  await queue.close();
  const guardRoot = path.join(temporary, corrupt ? "corrupt-guard" : "normal-guard"); await fs.mkdir(guardRoot);
  const { guardPath, attemptsPath } = await executionGuard(guardRoot), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, { NODE_OPTIONS: "", PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, OUTPUTS_DIR: outputsDir, CONFIG_DIR: configDir,
    MASTER_DB_PATH: path.join(dataDir, "master_db", "test.sqlite"), MASTER_DB_WRITE_MODE: "off", SEED_OUTPUTS_FROM_REPO: "0",
    TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", COLLECTOR_EXECUTION_MODE: "worker",
    COLLECTOR_WORKER_TOKEN: "postprocess-fixture-token-12345678901234567890", COLLECTOR_WORKER_ID: "postprocess-fixture-worker",
    GLAMPING_ADMIN_USER: ADMIN.username, GLAMPING_ADMIN_PASSWORD: ADMIN.password, GLAMPING_B2B_USER: MEMBER.username,
    GLAMPING_B2B_PASSWORD: MEMBER.password, GLAMPING_B2B_ENABLED: "1", RENDER_GIT_COMMIT: "postprocess-local-fixture" });
  const child = spawn(process.execPath, ["--max-old-space-size=512", "--require", guardPath, path.join(ROOT, "scripts/glamping_app_server.cjs")],
    { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
  const logs = [];
  const log = value => { logs.push(String(value)); if (logs.length > 200) logs.shift(); };
  child.stdout.on("data", log); child.stderr.on("data", log);
  try {
    await waitUntil(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw Error("Fixture server stopped before readiness: " + logs.join(""));
      try { return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
    }, "postprocess fixture startup timed out", 20000);
    const route = "/api/collection-postprocess", admin = await login(base, ADMIN), member = await login(base, MEMBER);
    assert.equal((await request(base, route)).response.status, 401);
    assert.equal((await request(base, route, member)).response.status, 403);
    assert.equal((await request(base, route, admin, jsonPost({ runId: artifact.runId }))).response.status, 405);
    if (!corrupt) {
      const privateRow = await request(base, route + "?runId=fixture_private_held", admin);
      assert.equal(privateRow.response.status, 200); assert.equal(privateRow.body.state, "held");
      assert.equal(privateRow.body.context, undefined); assert.equal(privateRow.body.b2bSubscribers, undefined);
      assert.equal(JSON.stringify(privateRow.body).includes(PRIVATE_CONTEXT), false);
      assert.ok(Buffer.byteLength(JSON.stringify(privateRow.body)) < 4096, "status remains small metadata rather than source/context payload");
      let prepared;
      await waitUntil(async () => {
        const response = await request(base, route + "?runId=" + artifact.runId, admin);
        assert.equal(response.response.status, 200, JSON.stringify(response.body)); prepared = response.body;
        if (prepared.state === "failed") throw Error("Automatic saved-run postprocessing failed: " + JSON.stringify(prepared) + logs.join(""));
        return prepared.state === "complete";
      }, "automatic saved-run postprocess did not complete: " + logs.join(""), 20000);
      assert.equal(prepared.attempts, 1); assert.equal(prepared.lastErrorCode, null); assert.ok(prepared.timings.durationMs >= 0);
      assert.ok(Object.hasOwn(prepared.result.stages, "historyMs")); assert.ok(Object.hasOwn(prepared.result.stages, "timingMs"));
      assert.equal(prepared.result.appended, 0, "a source with no room/product observations remains a real zero appended count");
      const master = JSON.parse(await fs.readFile(path.join(dataDir, "company_master", "companies.json")));
      assert.ok(Object.values(master.companies).some(company => company.primaryName === "통합시험숙소" && company.lastRunId === artifact.runId), "automatic postprocess updates the company master without a user opening that run");
      const timings = JSON.parse(await fs.readFile(path.join(dataDir, "history", "crawl_timings.json")));
      assert.equal(timings.entries.filter(row => row.runId === artifact.runId).length, 1);
      const list = await request(base, route, admin); assert.equal(list.response.status, 200);
      const publicText = JSON.stringify(list.body);
      for (const hidden of [PRIVATE_CONTEXT, "PRIVATE_MEMBER_CONTEXT", "manifestSha256", ADMIN.password, MEMBER.password]) assert.equal(publicText.includes(hidden), false);
      assert.equal((await request(base, route + "?runId=not_saved_run", admin)).body, null);
    } else {
      const unavailable = await request(base, route, admin);
      assert.equal(unavailable.response.status, 503); assert.equal(unavailable.body.error, "COLLECTION_POSTPROCESS_STATE_INVALID");
    }
    const archive = await request(base, "/api/runs", admin);
    assert.equal(archive.response.status, 200);
    const saved = archive.body.runs.find(row => row.id === artifact.runId); assert.ok(saved, "queue trouble never hides published source results");
    assert.equal(saved.postprocess.state, corrupt ? "unavailable" : "complete");
    if (!corrupt) {
      const derivedFiles = [path.join(dataDir, "company_master", "companies.json"), path.join(dataDir, "history", "crawl_timings.json")];
      const before = await Promise.all(derivedFiles.map(file => fs.readFile(file)));
      const detail = await request(base, "/api/runs/" + artifact.runId, admin);
      assert.equal(detail.response.status, 200);
      assert.equal(detail.body.postprocess.state, "complete");
      assert.deepEqual(await Promise.all(derivedFiles.map(file => fs.readFile(file))), before,
        "opening an already-queued result cannot repeat master/history/timing postprocessing");
    }
    const history = await request(base, `/api/collection-history?from=${day}&to=${day}&groupBy=day&groupKey=${day}&limit=50`, admin);
    assert.equal(history.response.status, 200);
    const recorded = history.body.rows.find(row => row.runId === artifact.runId); assert.ok(recorded, "saved result remains selectable in collection history");
    assert.equal(recorded.postprocess.state, corrupt ? "unavailable" : "complete");
    if (corrupt) assert.equal(recorded.postprocess.errorCode, "COLLECTION_POSTPROCESS_STATUS_UNAVAILABLE");
    else assert.equal(recorded.postprocess.runId, saved.postprocess.runId);
    for (const [name, expected] of Object.entries(sourceHashes)) assert.equal(sha(await fs.readFile(path.join(artifact.runDir, name))), expected, "postprocessing preserves every source byte");
    assert.equal(await fs.stat(attemptsPath).catch(() => null), null, "all provider/network/crawler calls are forbidden, including during startup and archive reads");
    assert.equal(logs.join("").includes(PRIVATE_CONTEXT), false);
    console.log("PASS real HTTP postprocess " + (corrupt ? "corrupt queue: app/archive/history remain available, source preserved" : "normal queue: admin-only status, automatic company update, linked archive/history, source preserved") + ", no provider IO");
  } finally { await stopChild(child); }
}
async function main() {
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "collection-postprocess-api-"));
  try { await scenario(temporary, false); await scenario(temporary, true); }
  finally {
    assert.ok(path.resolve(temporary).startsWith(path.resolve(await fs.realpath(os.tmpdir())) + path.sep));
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
