"use strict";

const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawn } = require("node:child_process"), { DatabaseSync } = require("node:sqlite");
const { createCollectionRotationScheduler } = require("./collection_rotation_scheduler.cjs");
const { inspectManifest } = require("./daily_collection_quality.cjs");
const { freePort, request, jsonPost, login, waitUntil, stopChild, writeMockArtifacts, executionGuard } = require("./test_collector_integration.cjs");
const ROOT = path.resolve(__dirname, ".."), TOKEN = "rotation-recovery-api-fixture-12345678901234567890";
const ADMIN = { username: "reconcile-admin", password: "reconcile-admin-fixture-password" };
const MEMBER = { username: "reconcile-member", password: "reconcile-member-fixture-password" };
const sha = value => crypto.createHash("sha256").update(value).digest("hex");

async function main() {
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "rotation-reconcile-api-"));
  const dataDir = path.join(temporary, "data"), outputsDir = path.join(dataDir, "outputs"), configDir = path.join(dataDir, "config");
  await fs.mkdir(configDir, { recursive: true }); await fs.mkdir(outputsDir);
  const day = new Date(Date.now() + 9 * 3600000 - 86400000).toISOString().slice(0, 10);
  const checkout = new Date(Date.parse(day + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  const acceptedAt = day + "T11:00:00.000Z", startedAt = day + "T11:00:29.000Z", finishedAt = day + "T11:01:00.000Z";
  const slotId = `rotation_${day}_1`, keyword = "복구시험글램핑", jobId = "collector_" + crypto.randomUUID(), runToken = "a".repeat(24);
  const scheduler = createCollectionRotationScheduler({ dataDir, now: () => new Date(acceptedAt), executeSlot: () => { throw Error("Must not collect"); } });
  const config = { ...scheduler.status().config, firstDate: day, time: "20:00", keywords: [keyword, "다음시험글램핑"],
    workers: [{ workerKey: "manual", dailyLimit: 1 }, { workerKey: "web", dailyLimit: 1 }], keywordIntervalMinutes: 60,
    collection: { bookingDays: 1, collectionMode: "precision", collectionPurpose: "revenue_detail", detailRankRanges: "1-1", productMode: "all", dayUseMode: "inspect" } };
  await scheduler.updateConfig(config, { startKeyword: keyword }); scheduler.close();
  const database = new DatabaseSync(path.join(configDir, "collection-rotation.sqlite"));
  database.prepare("INSERT INTO rotation_days VALUES(?,?,?,?,?,?)").run(day, 1, 0, 0, JSON.stringify(config), acceptedAt);
  const receipt = { version: 1, id: slotId, workerKey: "manual", keyword, day, acceptedAt };
  database.prepare("INSERT INTO rotation_slots(id,day,slot_index,worker_key,keyword,scheduled_at,status,started_at,error_code,receipt_json) VALUES(?,?,0,'manual',?,?,'uncertain',?,'ROTATION_RESTART_EXECUTION_UNCERTAIN',?)")
    .run(slotId, day, keyword, acceptedAt, acceptedAt, JSON.stringify(receipt));
  database.prepare("UPDATE rotation_state SET plan_state='review',reason='ROTATION_UNRESOLVED_EXECUTION' WHERE id=1").run(); database.close();
  const artifact = await writeMockArtifacts({ OUTPUTS_DIR: outputsDir, CHECK_IN: day, CHECK_OUT: checkout, ADULTS: 2, SEARCH_MODE: "keyword",
    COLLECTION_MODE: "precision", COLLECTION_PURPOSE: "revenue_detail", PRODUCT_MODE: "all", DAY_USE_MODE: "inspect", BOOKING_RANGE_DAYS: 1,
    BOOKING_RANGE_PLACE_LIMIT: 1, DETAIL_RANK_RANGES: "1-1", SCHEDULED_COLLECTION: "1", COLLECTOR_WORKER_KEY: "manual",
    COLLECTOR_TRIGGER: "scheduled", COLLECTOR_JOB_ID: jobId, COLLECTOR_ENGINE: "current-manual-v2", COLLECTOR_RUN_TOKEN: runToken }, keyword, 29, false);
  const manifestFile = path.join(artifact.runDir, "manifest.json"), manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  Object.assign(manifest, { collectorRunToken: runToken, startedAt, collectedAt: finishedAt, adults: 2, bookingRangeDays: 1, bookingRangePlaceLimit: 1 });
  manifest.collectionQuality = inspectManifest(manifest); assert.equal(manifest.collectionQuality.status, "complete");
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const files = await Promise.all(["manifest.json", artifact.csv].map(async name => {
    const bytes = await fs.readFile(path.join(artifact.runDir, name)); return { path: name, size: bytes.length, sha256: sha(bytes) };
  }));
  await fs.mkdir(path.join(dataDir, "collector"));
  await fs.writeFile(path.join(dataDir, "collector", "jobs.json"), JSON.stringify({ version: 1, halted: null, jobs: [{
    id: jobId, keyword, workerKey: "manual", trigger: "scheduled", status: "completed", runId: artifact.runId, outputDir: artifact.runDir,
    createdAt: acceptedAt, updatedAt: finishedAt, startedAt, finishedAt, leaseReleasedAt: finishedAt, manifest,
    collectionQuality: manifest.collectionQuality, completion: { publishedFiles: files }, uploads: Object.fromEntries(files.map(file => [file.path, file]))
  }] }));
  const { guardPath, attemptsPath } = await executionGuard(temporary), port = await freePort(), base = `http://127.0.0.1:${port}`;
  let server; const logs = [];
  try {
    server = spawn(process.execPath, ["--require", guardPath, path.join(ROOT, "scripts/glamping_app_server.cjs")], { cwd: ROOT, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "", PORT: String(port), HOST: "127.0.0.1",
        DATA_DIR: dataDir, OUTPUTS_DIR: outputsDir, CONFIG_DIR: configDir, SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off",
        MASTER_DB_PATH: path.join(dataDir, "master_db", "test.sqlite"), TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0",
        TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", COLLECTOR_EXECUTION_MODE: "worker", COLLECTOR_WORKER_TOKEN: TOKEN,
        COLLECTOR_WORKER_ID: "reconcile-fixture-worker", GLAMPING_ADMIN_USER: ADMIN.username, GLAMPING_ADMIN_PASSWORD: ADMIN.password,
        GLAMPING_B2B_USER: MEMBER.username, GLAMPING_B2B_PASSWORD: MEMBER.password, GLAMPING_B2B_ENABLED: "1" } });
    server.stdout.on("data", value => logs.push(String(value))); server.stderr.on("data", value => logs.push(String(value)));
    await waitUntil(async () => { if (server.exitCode !== null) throw Error(logs.join("")); try { return (await fetch(base + "/api/health")).ok; } catch { return false; } }, "reconciliation app startup", 20000);
    const admin = await login(base, ADMIN), member = await login(base, MEMBER), route = "/api/collection-rotation/reconcile";
    const payload = { slotId, runId: artifact.runId, dryRun: true, reviewLegacy: true };
    for (const [cookie, status] of [["", 401], [member, 403]]) assert.equal((await request(base, route, cookie, jsonPost(payload))).response.status, status);
    const api = (body, extra) => request(base, route, admin, { ...jsonPost(body), ...extra });
    assert.equal((await api(payload, { headers: { "Content-Type": "application/json", Origin: "https://wrong.example" } })).response.status, 403);
    assert.equal((await api(payload, { headers: { "Content-Type": "text/plain", Origin: base } })).response.status, 415);
    const preview = await api(payload); assert.equal(preview.response.status, 200, JSON.stringify({ body: preview.body, logs }));
    assert.equal(preview.body.applied, false); assert.equal(preview.body.proof.bindingMode, "administrator_reviewed_legacy");
    assert.equal(preview.body.proof.verifiedFiles, 2);
    const before = await request(base, "/api/collection-rotation", admin); assert.equal(before.body.latest[0].status, "uncertain"); assert.equal(before.body.enabled, false);
    const apply = { ...payload, dryRun: false, expectedVersion: preview.body.expectedVersion };
    const connected = await api(apply); assert.equal(connected.response.status, 200, JSON.stringify(connected.body));
    assert.equal(connected.body.item.status, "complete"); assert.equal(connected.body.item.runId, artifact.runId); assert.equal(connected.body.item.startedAt, startedAt);
    assert.equal((await api(apply)).body.alreadyApplied, true);
    const status = (await request(base, "/api/collection-rotation", admin)).body;
    assert.equal(status.enabled, false); assert.equal(status.nextRunAt, null); assert.equal(status.latest[0].status, "complete");
    for (const file of files) assert.equal(sha(await fs.readFile(path.join(artifact.runDir, file.path))), file.sha256);
    assert.equal((await fs.stat(attemptsPath).catch(() => null)), null, "reconciliation makes no external/provider or crawler call");
    console.log("PASS real HTTP reconciliation: admin+origin+JSON guards, reviewed legacy preview/apply/idempotence, original artifacts and disabled scheduling preserved, no provider IO");
  } finally { await stopChild(server); await fs.rm(temporary, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
