"use strict";

// Full local server + real saved-artifact ingestion. The 20 companies and 420
// lodging observations are explicitly synthetic. No operating source is read.
// executionGuard forbids provider IO and collector subprocesses in the child.
// This server test cannot verify a browser's selected month or card rendering.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createCollectionPostprocessQueue } = require("./lib/collection_postprocess_queue.cjs");
const { createCollectionRotationScheduler, defaultConfig } = require("./collection_rotation_scheduler.cjs");
const { inspectManifest } = require("./daily_collection_quality.cjs");
const { freePort, request, login, waitUntil, stopChild, executionGuard } = require("./test_collector_integration.cjs");
const ROOT = path.resolve(__dirname, "..");
const ADMIN = { username: "history-ingest-fixture-admin", password: "history-ingest-fixture-admin-password" };
const MEMBER = { username: "history-ingest-fixture-member", password: "history-ingest-fixture-member-password" };
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const addDays = (day, count) => new Date(Date.parse(day + "T00:00:00Z") + count * 86400000).toISOString().slice(0, 10);
const csvCell = value => { const text = String(value ?? ""); return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };

async function snapshot(files) {
  return Promise.all(files.map(async file => ({ file, hash: sha(await fs.readFile(file)), mtimeMs: (await fs.stat(file)).mtimeMs })));
}
async function unchanged(before) {
  for (const value of before) {
    assert.equal(sha(await fs.readFile(value.file)), value.hash, "GET/postprocessing must preserve the recorded bytes: " + path.basename(value.file));
    assert.equal((await fs.stat(value.file)).mtimeMs, value.mtimeMs, "GET/postprocessing must preserve the recorded modification time: " + path.basename(value.file));
  }
}

async function prepareFixture(dataDir) {
  const outputsDir = path.join(dataDir, "outputs"), configDir = path.join(dataDir, "config");
  await fs.mkdir(configDir, { recursive: true });
  const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const dates = Array.from({ length: 21 }, (_, index) => addDays(day, index));
  // A fixed synthetic 11:00 KST clock avoids crossing midnight between fixture
  // day selection and the durable scheduler receipt. It is not a real crawl.
  const startedAt = new Date(`${day}T11:00:00+09:00`).toISOString();
  const finishedAt = new Date(Date.parse(startedAt) + 2000).toISOString();
  const runId = `ingest_fixture_glamping_${day.replaceAll("-", "")}_110000`, slotId = `rotation_${day}_1`;
  const runDir = path.join(outputsDir, runId), csv = "synthetic_20companies_overall_place_rank.csv";
  await fs.mkdir(runDir, { recursive: true });
  const plan = { keyword: "합성후처리글램핑", checkIn: day, checkOut: dates.at(-1), adults: 2, searchMode: "keyword",
    searchScope: "lodging_type:글램핑", workerKey: "manual", trigger: "scheduled", collectionMode: "precision",
    collectionPurpose: "revenue_detail", detailRankRanges: "1-20", productMode: "all", dayUseMode: "inspect",
    bookingRangeDays: 21, bookingRangePlaceLimit: 20 };
  const headers = ["channel", "name", "price", "url", "place_id", "업체명", "overall_rank", "전체순위", "주소", "카테고리", "숙박유형클러스터",
    "네이버예약사업자ID", "예약", "네이버예약재고수집상태", "숙박예약가능수", "숙박확인재고수", "주간재고수집일수", "주간기준재고수",
    "예약최저가", "예약리스트유형", "weeklyProductDetailsJson", "dayUseMode", "dayUsePresence", "dayUseScheduleStatus"];
  const companies = Array.from({ length: 20 }, (_, index) => {
    const placeId = String(910000001 + index), businessId = String(920000001 + index), name = `합성후처리업체${String(index + 1).padStart(2, "0")}`;
    const products = dates.map(date => ({ date, bizItemId: `fixture-room-${index + 1}`, name: "합성 숙박 객실", productType: "lodging", saleType: "숙박",
      listType: "객실 종류별 리스트", availabilityUnit: "객실", stock: 2, total: 2, available: 1, bookingCount: 1, sold: 1, price: 100000, open: true }));
    const values = ["네이버", name, "100000", `https://pcmap.place.naver.com/accommodation/${placeId}`, placeId, name, index + 1, index + 1,
      `경상남도 산청군 합성검수로 ${index + 1}`, "글램핑", "글램핑", businessId, "Y", "수집 완료", 1, 2, 21, 2, 100000,
      "객실 종류별 리스트", JSON.stringify(products), "inspect", "absent", "not_requested"];
    return { placeId, businessId, name, values };
  });
  await fs.writeFile(path.join(runDir, csv), [headers, ...companies.map(company => company.values)].map(row => row.map(csvCell).join(",")).join("\n") + "\n");
  const manifest = { ...plan, schemaVersion: 2, outputDir: runDir, startedAt, completedAt: finishedAt, collectedAt: finishedAt,
    workerCollection: true, scheduledCollection: true, sourceRole: "admin", collectionSource: "admin_search",
    collectorEngine: "synthetic-fixture-no-provider", collectionProfile: "revenue_detail_deep",
    collectionProfileFlags: { collectBookingStock: true, collectWeeklyRange: true, collectRegional: false, collectOta: false },
    naverAttemptedQueries: [{ status: 200 }], files: [csv], fileRoles: { overall: csv, platform: csv }, detailJsonFiles: [],
    schedulingReceipt: { scheduleOccurrenceId: slotId, jobId: "collector_fixture_20x21" },
    counts: { naverOverall: 20, naverBookingStockEligible: 20, naverBookingStockChecked: 20, naverBookingStockSucceeded: 20,
      naverOtaObservationChecked: 0, naverOtaBlocked: 0, naverOtaFailed: 0, naverScheduleRequested: 420,
      naverScheduleSucceeded: 420, naverScheduleFailed: 0, naverScheduleBlocked: 0 },
    productCoverage: { version: 1, discovered: 20, eligible: 20, excluded: 0, queried: 20, truncated: 0,
      targets: companies.map(company => ({ businessId: company.businessId, discovered: 1, eligible: 1, excluded: 0, queried: 1, truncated: 0,
        expectedDays: 21, productListComplete: true, dayUseMode: "inspect", dayUsePresence: "absent", dayUseExcludedByMode: 0,
        dayUseSchedulesRequested: false, days: dates.map(date => ({ date, eligible: 1, queried: 1, succeeded: 1, failed: 0, truncated: 0 })) })) } };
  manifest.collectionQuality = inspectManifest(manifest, plan);
  assert.equal(manifest.collectionQuality.status, "complete", JSON.stringify(manifest.collectionQuality));
  await fs.writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest));
  const original = await snapshot([path.join(runDir, "manifest.json"), path.join(runDir, csv)]);
  const queue = createCollectionPostprocessQueue({ dataDir: path.join(dataDir, "history"), processRun: async () => { throw Error("Parent fixture must not process source"); } });
  await queue.enqueue(runId, { deferred: true, context: { plan, estimate: {}, startedAt, endedAt: finishedAt, stageTimings: [],
    collectionSource: "admin_search", sourceRole: "admin", workerKey: "manual", trigger: "scheduled", scheduleOccurrenceId: slotId,
    historyPayload: plan, manifestSha256: original.find(row => path.basename(row.file) === "manifest.json").hash, b2bSubscribers: [] } });
  assert.equal((await queue.status({ runId })).state, "held"); await queue.close();
  // Seed the real durable scheduler using its public fixture callback. This
  // returns an already-saved artifact; no crawler or HTTP provider is invoked.
  let at = new Date(startedAt), fixtureExecutions = 0;
  const scheduler = createCollectionRotationScheduler({ dataDir, now: () => at, getFreeBytes: async () => 1024 ** 3,
    getWorkerState: async () => ({ ready: true, halted: false, active: false, retired: false }),
    inspectResult: async (_result, payload) => inspectManifest(manifest, payload),
    executeSlot: async (payload, slot) => {
      fixtureExecutions++; assert.equal(slot.id, slotId); assert.equal(payload.bookingRangeDays, 21);
      at = new Date(finishedAt); return { runId, output: manifest, collectionQuality: manifest.collectionQuality, executionStartedAt: startedAt };
    } });
  try {
    const localClock = new Date(Date.parse(startedAt) + 9 * 3600000).toISOString().slice(11, 16);
    await scheduler.updateConfig({ ...defaultConfig(at), firstDate: day, time: localClock, keywords: [plan.keyword],
      workers: [{ workerKey: "manual", dailyLimit: 1 }], collection: { bookingDays: 21, collectionMode: "precision", collectionPurpose: "revenue_detail",
        detailRankRanges: "1-20", productMode: "all", dayUseMode: "inspect" } }, { startKeyword: plan.keyword });
    await scheduler.setEnabled(true); const committed = await scheduler.tick();
    assert.equal(committed.status, "complete"); assert.equal(committed.runId, runId); assert.equal(fixtureExecutions, 1);
    await scheduler.setEnabled(false);
  } finally { scheduler.close(); }
  return { dataDir, outputsDir, configDir, day, dates, runId, slotId, plan, original, companies, finishedAt };
}

async function main() {
  const parent = await fs.realpath(os.tmpdir()), temporary = await fs.mkdtemp(path.join(parent, "collection-history-ingest-"));
  let child; const began = performance.now(); const logs = [];
  try {
    const fixture = await prepareFixture(path.join(temporary, "data"));
    const guardRoot = path.join(temporary, "guard"); await fs.mkdir(guardRoot);
    const { guardPath, attemptsPath } = await executionGuard(guardRoot), port = await freePort(), base = `http://127.0.0.1:${port}`;
    const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE"]
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    Object.assign(env, { NODE_OPTIONS: "", PORT: String(port), HOST: "127.0.0.1", DATA_DIR: fixture.dataDir, OUTPUTS_DIR: fixture.outputsDir,
      CONFIG_DIR: fixture.configDir, MASTER_DB_PATH: path.join(fixture.dataDir, "master_db", "fixture.sqlite"), MASTER_DB_WRITE_MODE: "off",
      SEED_OUTPUTS_FROM_REPO: "0", TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0",
      COLLECTOR_EXECUTION_MODE: "worker", COLLECTOR_WORKER_TOKEN: "fixture-history-ingest-token-12345678901234567890",
      COLLECTOR_WORKER_ID: "fixture-history-ingest-worker", GLAMPING_ADMIN_USER: ADMIN.username, GLAMPING_ADMIN_PASSWORD: ADMIN.password,
      GLAMPING_B2B_USER: MEMBER.username, GLAMPING_B2B_PASSWORD: MEMBER.password, GLAMPING_B2B_ENABLED: "1", RENDER_GIT_COMMIT: "local-synthetic-history-ingest" });
    const childStarted = performance.now();
    child = spawn(process.execPath, ["--max-old-space-size=512", "--require", guardPath, path.join(ROOT, "scripts/glamping_app_server.cjs")],
      { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    const capture = value => { logs.push(String(value)); if (logs.length > 200) logs.shift(); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    await waitUntil(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw Error("Synthetic fixture server stopped: " + logs.join(""));
      try { return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
    }, "history-ingest fixture startup timeout", 30000);
    const admin = await login(base, ADMIN), member = await login(base, MEMBER), route = "/api/collection-postprocess";
    assert.equal((await request(base, route)).response.status, 401);
    assert.equal((await request(base, route, member)).response.status, 403);
    let completed;
    await waitUntil(async () => {
      const response = await request(base, route + "?runId=" + fixture.runId, admin);
      assert.equal(response.response.status, 200, JSON.stringify(response.body)); completed = response.body;
      if (completed.state === "failed") throw Error("Synthetic automatic ingestion failed: " + JSON.stringify(completed) + logs.join(""));
      return completed.state === "complete";
    }, "20x21 automatic history-ingest timeout: " + logs.join(""), 60000);
    const completedObservedMs = performance.now() - childStarted;
    assert.equal(completed.attempts, 1); assert.equal(completed.result.appended, 420); assert.equal(completed.lastErrorCode, null);
    assert.equal(completed.scheduleOccurrenceId, fixture.slotId);
    for (const key of ["validationMs", "historyMs", "historyLoadMs", "historyIdScanMs", "historyAppendMs", "historyIntegrationQueueMs", "timingMs", "industryMs", "memberHistoryMs"])
      assert.ok(Number.isFinite(completed.result.stages[key]) && completed.result.stages[key] >= 0, "actual stage timing required: " + key);
    const historyFile = path.join(fixture.dataDir, "history", "observations.jsonl"), masterFile = path.join(fixture.dataDir, "company_master", "companies.json"), timingFile = path.join(fixture.dataDir, "history", "crawl_timings.json");
    const observations = (await fs.readFile(historyFile, "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line));
    const thisRun = observations.filter(row => row.runId === fixture.runId);
    assert.equal(observations.length, 420); assert.equal(thisRun.length, 420); assert.equal(new Set(thisRun.map(row => row.observationId)).size, 420);
    assert.equal(new Set(thisRun.map(row => row.companyKey)).size, 20);
    for (const row of thisRun) {
      assert.equal(row.productType, "lodging"); assert.ok(fixture.dates.includes(row.stayDate));
      assert.equal(row.supply, 2); assert.equal(row.available, 1); assert.equal(row.sold, 1);
      assert.equal(row.estimatedRevenue, 100000); assert.equal(row.dayUseMode, "inspect");
    }
    for (const companyKey of new Set(thisRun.map(row => row.companyKey))) assert.equal(new Set(thisRun.filter(row => row.companyKey === companyKey).map(row => row.stayDate)).size, 21);
    const companies = Object.values(JSON.parse(await fs.readFile(masterFile, "utf8")).companies);
    assert.equal(companies.length, 20); assert.equal(new Set(companies.map(company => company.companyId)).size, 20);
    for (const company of companies) assert.equal(company.lastRunId, fixture.runId);
    const timings = JSON.parse(await fs.readFile(timingFile, "utf8"));
    assert.equal(timings.entries.filter(row => row.runId === fixture.runId).length, 1);
    const baseline = await snapshot([historyFile, masterFile, timingFile]);
    const getTimes = [];
    for (let iteration = 0; iteration < 2; iteration++) {
      const started = performance.now(), archive = await request(base, "/api/runs", admin); getTimes.push(performance.now() - started);
      assert.equal(archive.response.status, 200); const run = archive.body.runs.find(row => row.id === fixture.runId);
      assert.ok(run); assert.equal(run.workerKey, "manual"); assert.equal(run.trigger, "scheduled");
      assert.equal(run.collectionQuality.status, "complete"); assert.equal(run.postprocess.state, "complete");
      assert.equal(run.collectedAt, fixture.finishedAt); assert.equal(run.bookingRangeDays, 21); assert.equal(run.detailRankRanges, "1-20");
      const detail = await request(base, "/api/runs/" + fixture.runId, admin);
      assert.equal(detail.response.status, 200); assert.equal(detail.body.postprocess.state, "complete");
      assert.equal(detail.body.run.id, fixture.runId); assert.equal(detail.body.run.checkIn, fixture.plan.checkIn); assert.equal(detail.body.run.checkOut, fixture.plan.checkOut);
      const rotation = await request(base, `/api/collection-rotation/history?from=${fixture.day}&to=${fixture.day}`, admin);
      assert.equal(rotation.response.status, 200); const slot = rotation.body.items.find(row => row.id === fixture.slotId);
      assert.ok(slot); assert.equal(slot.status, "complete"); assert.equal(slot.runId, fixture.runId); assert.equal(slot.postprocess.state, "complete");
      const history = await request(base, `/api/collection-history?from=${fixture.day}&to=${fixture.day}&groupBy=day&groupKey=${fixture.day}&limit=50`, admin);
      assert.equal(history.response.status, 200); const row = history.body.rows.find(item => item.source === "rotation" && item.runId === fixture.runId);
      assert.ok(row); assert.equal(row.state, "complete"); assert.equal(row.postprocess.state, "complete");
      assert.equal(row.conditions.bookingRangeDays, 21); assert.equal(row.conditions.dayUseMode, "inspect");
    }
    await unchanged(fixture.original); await unchanged(baseline);
    assert.equal(await fs.stat(attemptsPath).catch(() => null), null, "provider IO and crawler subprocess attempts must remain exactly zero");
    assert.ok(child.exitCode === null && child.signalCode === null);
    console.log(JSON.stringify({ status: "passed", scope: "local synthetic full HTTP app; not production or browser UI timing", companies: 20,
      lodgingObservations: 420, uniqueObservationIds: 420, productDatesPerCompany: 21, publicSoldPerDate: 1, estimatedRevenuePerDate: 100000,
      sameRunAfterGetPreserved: true, archiveAndRotationHistory: "complete", sourceAndHistoryBytesAndMtimesUnchanged: true,
      providerAttempts: 0, collectorSubprocessAttempts: 0, childMaxOldSpaceMiB: 512,
      completionObservedAfterChildStartMs: Number(completedObservedMs.toFixed(3)), postprocessTimings: completed.timings,
      stageMs: completed.result.stages, archiveGetMs: getTimes.map(value => Number(value.toFixed(3))),
      totalFixtureMs: Number((performance.now() - began).toFixed(3)), selectedMonthBrowserState: "not_tested_by_server_fixture" }));
  } finally {
    await stopChild(child);
    assert.ok(path.resolve(temporary).startsWith(path.resolve(parent) + path.sep));
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
