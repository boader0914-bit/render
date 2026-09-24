"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { workerOptions, runWorker } = require("./collector_worker.cjs");
const { freePort, request, jsonPost, login, waitUntil, stopChild, executionGuard, writeMockArtifacts } = require("./test_collector_integration.cjs");

const ROOT = path.resolve(__dirname, "..");
const TOKEN = "recovery-test-worker-token-12345678901234567890";
const WORKER = "recovery-test-worker";
const ADMIN = { username: "recovery-test-admin", password: "recovery-test-admin-fixture-password" };
const B2B = { username: "recovery-test-member", password: "recovery-test-member-fixture-password" };
const DAY = value => new Date(value + 9 * 3600000).toISOString().slice(0, 10);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const csvCell = value => `"${String(value ?? "").replaceAll('"', '""')}"`;

async function retainedFixture(env, keyword, { legacy = false } = {}) {
  const fixture = await writeMockArtifacts(env, keyword, 31, false);
  const manifestPath = path.join(fixture.runDir, "manifest.json");
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  if (legacy) delete manifest.dayUseMode;
  manifest.collectorRunToken = env.COLLECTOR_RUN_TOKEN;
  manifest.startedAt = manifest.collectedAt;
  const products = [1, 2].map(index => ({
    date: env.CHECK_IN, bizItemId: String(800000 + index), name: `시험 객실 ${index}`, saleType: "숙박",
    availabilityUnit: "객실", stock: 5, bookingCount: index, occupiedBookingCount: 0,
    total: 5, available: 5 - index, price: 100000, collectionFailed: false, inventoryObserved: true, stockObserved: true,
  }));
  const detailFile = "details/123456_weekly_product_details_fixture.json";
  await fsp.mkdir(path.join(fixture.runDir, "details"));
  await fsp.writeFile(path.join(fixture.runDir, detailFile), JSON.stringify(products));
  const reference = { file: detailFile, field: "weekly_product_details", placeId: "123456", bookingBusinessId: "987654", itemCount: 2, originalLength: JSON.stringify(products).length };
  manifest.detailJsonFiles = [reference, { ...reference }];
  manifest.counts.detailJsonFiles = 2;
  const fields = {
    query: keyword, place_id: "123456", 업체명: "복구 통합시험 글램핑", overall_rank: 1,
    주소: "경남 산청군 시험로 1", 카테고리: "글램핑", 숙박유형클러스터: "글램핑", 예약: "Y",
    url: "https://pcmap.place.naver.com/accommodation/123456", 네이버예약사업자ID: "987654", 네이버예약재고수집상태: "수집 완료",
    숙박확인재고수: 10, 숙박예약가능수: 7, 숙박판매완료수: 3, 예약최저가: 100000,
    예약리스트유형: "객실 종류별 리스트", 주간재고수집일수: 1, 주간전체수량합계: 10, 주간판매수량합계: 3,
    네이버요일별상품상세JSON: JSON.stringify(products),
  };
  await fsp.writeFile(path.join(fixture.runDir, fixture.csv), `${Object.keys(fields).map(csvCell).join(",")}\n${Object.values(fields).map(csvCell).join(",")}\n`);
  await fsp.writeFile(manifestPath, JSON.stringify(manifest));
  return { ...fixture, manifest, detailFile };
}

function mockWorker(base, temporary, { legacy = false } = {}) {
  const errors = [], spawned = [], events = [], calls = [];
  const controller = new AbortController();
  let fixture;
  const options = workerOptions({ COLLECTOR_WORKER_ENABLED: "1", COLLECTOR_ALLOW_LOCAL_HTTP: "1", COLLECTOR_SERVER_URL: base,
    COLLECTOR_WORKER_KEY: "manual", COLLECTOR_WORKER_TOKEN: TOKEN, COLLECTOR_WORKER_ID: WORKER }, {
    cwd: ROOT, workDir: path.join(temporary, "worker-jobs"), maxJobs: 1, pollMs: 15, heartbeatMs: 80,
    heartbeatTimeoutMs: 1000, requestTimeoutMs: 5000, uploadAttempts: 1, retryMs: 15,
    signal: controller.signal, logger: value => events.push(value),
    fetchImpl: (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, base, "Worker networking must remain inside the local fixture");
      assert.ok(url.pathname.startsWith("/api/collector-worker/"));
      calls.push({ path: url.pathname, method: init.method });
      return fetch(input, init);
    },
    spawnImpl: (executable, args, config) => {
      assert.equal(executable, process.execPath);
      assert.equal(path.basename(args[0]), "gyeongnam_glamping_crawl.cjs");
      assert.equal(config.env.COLLECTOR_WORKER_TOKEN, undefined);
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let closed = false;
      const close = code => { if (closed) return; closed = true; child.stdout.end(); child.stderr.end(); child.emit("close", code); };
      child.kill = () => { setImmediate(() => close(1)); return true; };
      spawned.push(config);
      setImmediate(async () => {
        try { fixture = await retainedFixture(config.env, args[1], { legacy }); close(0); }
        catch (error) { errors.push(error); close(1); }
      });
      return child;
    },
  });
  const completed = runWorker(options); completed.catch(() => {});
  return { completed, errors, spawned, events, calls, fixture: () => fixture, stop: () => controller.abort() };
}

async function main({ legacy = false } = {}) {
  const temporaryBase = await fsp.realpath(os.tmpdir());
  const temporary = await fsp.mkdtemp(path.join(temporaryBase, "collector-recovery-integration-"));
  const dataDir = path.join(temporary, "data"), outputsDir = path.join(dataDir, "outputs"), configDir = path.join(dataDir, "config");
  let server, worker;
  try {
    await fsp.mkdir(configDir, { recursive: true });
    await fsp.mkdir(outputsDir);
    const masterFile = path.join(dataDir, "company_master", "companies.json");
    await fsp.mkdir(path.dirname(masterFile));
    await fsp.writeFile(masterFile, JSON.stringify({ version: 1, companies: {}, sourceIndex: {}, duplicateResolutions: {}, regionReviews: {}, regionReviewHistory: [] }));
    const { guardPath, attemptsPath } = await executionGuard(temporary);
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    const logs = [];
    const startServer = async () => {
      server = spawn(process.execPath, ["--require", guardPath, path.join(__dirname, "glamping_app_server.cjs")], {
      cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
        ...process.env, NODE_OPTIONS: "", PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, OUTPUTS_DIR: outputsDir, CONFIG_DIR: configDir,
        MASTER_DB_PATH: path.join(dataDir, "master_db", "fixture.sqlite"), MASTER_DB_WRITE_MODE: "off", SEED_OUTPUTS_FROM_REPO: "0",
        TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0",
        COLLECTOR_EXECUTION_MODE: "worker", COLLECTOR_WORKER_TOKEN: TOKEN, COLLECTOR_WORKER_ID: WORKER,
        COLLECTOR_SCHEDULED_WORKER_TOKEN: "", GLAMPING_ADMIN_USER: ADMIN.username, GLAMPING_ADMIN_PASSWORD: ADMIN.password,
        GLAMPING_B2B_USER: B2B.username, GLAMPING_B2B_PASSWORD: B2B.password, GLAMPING_B2B_ENABLED: "1",
      },
    });
    server.stdout.on("data", chunk => logs.push(String(chunk)));
    server.stderr.on("data", chunk => logs.push(String(chunk)));
    await waitUntil(async () => {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(logs.join(""));
      try { return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
    }, "Recovery fixture server did not start", 15000);
    };
    await startServer();
    let admin = await login(base, ADMIN), member = await login(base, B2B);
    worker = mockWorker(base, temporary, { legacy });
    await waitUntil(async () => Boolean((await request(base, "/api/collector-status", admin)).body.workerLastSeenAt), "Mock worker did not connect");
    const payload = { keyword: "경남글램핑", workerKey: "manual", searchMode: "keyword", adults: 2,
      checkIn: DAY(Date.now()), checkOut: DAY(Date.now() + 86400000), collectionMode: "precision", collectionPurpose: "revenue_detail",
      productMode: "all", bookingRangeDays: 1, bookingRangePlaceLimit: 0, detailRankRanges: "1-20", clientRequestId: "recovery-integration-request-0001" };
    if (legacy) payload.dayUseMode = "detail";
    const accepted = await request(base, "/api/crawl?async=1", admin, jsonPost(payload));
    assert.equal(accepted.response.status, 202, JSON.stringify(accepted.body));
    await worker.completed;
    assert.equal(worker.errors.length, 0, worker.errors[0]?.stack);
    assert.equal(worker.spawned.length, 1);
    let failed;
    await waitUntil(async () => {
      failed = (await request(base, `/api/crawl-requests/${payload.clientRequestId}`, admin)).body;
      return failed.status === "failed";
    }, "Failed upload did not reach its durable request receipt");
    assert.equal(failed.errorCode, "COLLECTOR_UPLOAD_FAILED");
    const fixture = worker.fixture();
    const ledgerFile = path.join(dataDir, "collector", "jobs.json");
    const ledger = JSON.parse(await fsp.readFile(ledgerFile, "utf8"));
    const job = ledger.jobs.find(row => row.keyword === payload.keyword);
    assert.equal(job.status, "failed");
    assert.equal(job.errorCode, "COLLECTOR_UPLOAD_FAILED");
    assert.equal(job.failurePhase, "final_validation");
    assert.equal(job.brokerErrorCode, "COLLECTOR_DUPLICATE_PATH");
    assert.equal(Object.keys(job.uploads).length, 3);
    assert.equal(job.env, undefined); assert.equal(job.payload, undefined);
    const retainedDir = path.join(dataDir, "collector", "staging", job.id);
    const sourceManifest = await fsp.readFile(path.join(retainedDir, "manifest.json"));
    const manifestSha256 = hash(sourceManifest);
    assert.equal(manifestSha256, job.uploads["manifest.json"].sha256);
    assert.equal(fs.existsSync(path.join(outputsDir, fixture.runId)), false);
    assert.equal((await request(base, "/api/runs", admin)).body.runs.some(row => row.id === fixture.runId), false);
    const expectedKeys = ["keyword", "checkIn", "checkOut", "adults", "searchMode", "searchIntent", "searchRegion", "searchScope", "collectionMode", "collectionPurpose", "productMode", "dayUseMode", "detailRankRanges", "bookingRangeDays", "bookingRangePlaceLimit", "sourceRole", "collectionSource", "workerKey", "trigger"];
    const expected = Object.fromEntries(expectedKeys.map(key => [key, fixture.manifest[key]]));
    expected.scheduledCollection = false;
    const body = { confirm: "recover-retained-result", workerKey: "manual", jobId: job.id, requestId: payload.clientRequestId, manifestSha256, expected };
    const recoverRoute = "/api/collector-recover";
    const reuseFile=path.join(dataDir,"history","collection-reuse.json");
    let legacyReuseBytes;
    if(legacy) {
      await stopChild(server);
      const stored=JSON.parse(await fsp.readFile(reuseFile,"utf8"));
      const oldScope=stored.entries.find(row=>row.scope.keyword===payload.keyword).scope;
      delete oldScope.dayUseMode;
      // Simulate real pre-selector evidence, including a different JSON key order.
      stored.entries.find(row=>row.scope.keyword===payload.keyword).scope=Object.fromEntries(Object.entries(oldScope).reverse());
      legacyReuseBytes=JSON.stringify(stored);
      await fsp.writeFile(reuseFile,legacyReuseBytes);
      await startServer();
      admin=await login(base,ADMIN);member=await login(base,B2B);
    }
    assert.equal((await request(base, recoverRoute, "", jsonPost(body))).response.status, 401);
    assert.equal((await request(base, recoverRoute, member, jsonPost(body))).response.status, 403);
    const crossOrigin = jsonPost(body); crossOrigin.headers.Origin = "https://unrelated.invalid";
    assert.equal((await request(base, recoverRoute, admin, crossOrigin)).response.status, 403);
    assert.equal((await request(base, recoverRoute, admin, jsonPost({ ...body, expected: { ...expected, adults: 3 } }))).response.status, 409);
    assert.equal((await request(base, recoverRoute, admin, jsonPost({ ...body, expected: { ...expected, dayUseMode: legacy ? "inspect" : "detail" } }))).response.status, 409, "Inspect and detail scopes must never be substituted during recovery");
    assert.equal((await request(base, recoverRoute, admin, jsonPost({ ...body, manifestSha256: "0".repeat(64) }))).response.status, 409);
    assert.equal(fs.existsSync(path.join(outputsDir, fixture.runId)), false, "Rejected recovery must not publish artifacts");

    const recovered = await request(base, recoverRoute, admin, jsonPost(body));
    assert.equal(recovered.response.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.ok, true);
    assert.equal(recovered.body.runId, fixture.runId);
    assert.equal(recovered.body.collectionQuality.status, "complete");
    assert.equal(recovered.body.recovery.duplicateReferences, 1);
    assert.ok(recovered.body.history.appended > 0, "Recovery must append actual observations");
    assert.equal(recovered.body.request.status, "complete");
    assert.equal(recovered.body.request.recovery.originalErrorCode, "COLLECTOR_UPLOAD_FAILED");
    const canonicalManifest = JSON.parse(await fsp.readFile(path.join(outputsDir, fixture.runId, "manifest.json"), "utf8"));
    assert.equal(canonicalManifest.detailJsonFiles.length, 1);
    assert.equal(canonicalManifest.outputDir, path.join(outputsDir, fixture.runId));
    assert.equal(canonicalManifest.recovery.originalManifestSha256, manifestSha256);
    assert.equal(hash(await fsp.readFile(path.join(retainedDir, "manifest.json"))), manifestSha256, "Original evidence must remain untouched");
    assert.equal((await request(base, "/api/runs", admin)).body.runs.filter(row => row.id === fixture.runId).length, 1);
    const companies = (await request(base, "/api/company-master/summary", admin)).body;
    assert.equal(companies.totalCompanies, 1);
    assert.ok(companies.companies.some(row => row.companyId === "cmp_place_123456"), "Recovered company must appear in the real company list API");
    const requestAfter = (await request(base, `/api/crawl-requests/${payload.clientRequestId}`, admin)).body;
    assert.equal(requestAfter.status, "complete");
    assert.equal(requestAfter.result.runId, fixture.runId);
    const historyFile = path.join(dataDir, "history", "observations.jsonl");
    const historyBeforeRepeat = await fsp.readFile(historyFile, "utf8"), masterBeforeRepeat = await fsp.readFile(masterFile, "utf8");
    const storedMaster = JSON.parse(masterBeforeRepeat);
    assert.equal(storedMaster.sourceIndex["place:123456"], "cmp_place_123456");
    assert.ok(storedMaster.companies.cmp_place_123456.placeIds.includes("123456"));
    const observations = historyBeforeRepeat.trim().split("\n").map(line => JSON.parse(line));
    assert.ok(observations.length > 0);
    assert.ok(observations.every(row => row.runId === fixture.runId && row.companyName === "복구 통합시험 글램핑"
      && row.sourceUrl === "https://pcmap.place.naver.com/accommodation/123456"));
    const repeated = await request(base, recoverRoute, admin, jsonPost(body));
    assert.equal(repeated.response.status, 200, JSON.stringify(repeated.body));
    assert.equal(repeated.body.history.appended, 0);
    assert.equal(await fsp.readFile(historyFile, "utf8"), historyBeforeRepeat);
    assert.equal(await fsp.readFile(masterFile, "utf8"), masterBeforeRepeat);
    assert.deepEqual(repeated.body.request, requestAfter, "Repeated recovery must retain the first recovery receipt");
    const jobAfter = JSON.parse(await fsp.readFile(ledgerFile, "utf8")).jobs.find(row => row.id === job.id);
    assert.equal(jobAfter.status, "failed", "Broker execution provenance remains failed after artifact recovery");
    assert.equal(jobAfter.errorCode, job.errorCode);
    assert.equal(jobAfter.finishedAt, job.finishedAt);
    assert.equal(jobAfter.recovery.runId, fixture.runId);
    const finalStatus = (await request(base, "/api/collector-status", admin)).body;
    assert.equal(finalStatus.halted, true, "Recovery must not release the existing safety halt");
    assert.equal(finalStatus.activeJobId, null); assert.equal(finalStatus.queued, 0);
    assert.equal(worker.spawned.length, 1, "Recovery must not start another crawl");
    if(legacy) assert.equal(await fsp.readFile(reuseFile,"utf8"),legacyReuseBytes,"Legacy scope evidence must not be rewritten by recovery");
    assert.equal(fs.existsSync(attemptsPath), false, "Server recovery must not perform provider requests or spawn a crawler");
    console.log(`collector recovery integration passed (${legacy?"legacy missing day-use scope":"inspect scope"}): failed duplicate-reference upload -> ${observations.length} observations, company list, archive and durable request recovered; repeat idempotent, original failure retained, auth/scope/hash rejected; external IO forbidden`);
  } finally {
    worker?.stop();
    await worker?.completed.catch(() => {});
    await stopChild(server);
    const actual = await fsp.realpath(temporary), relative = path.relative(temporaryBase, actual);
    assert.equal(path.isAbsolute(relative), false); assert.equal(relative.startsWith(".."), false);
    assert.equal(path.dirname(relative), "."); assert.ok(path.basename(relative).startsWith("collector-recovery-integration-"));
    await fsp.rm(actual, { recursive: true, force: true });
  }
}

if (require.main === module) (async()=>{await main();await main({legacy:true});})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { retainedFixture, mockWorker };
