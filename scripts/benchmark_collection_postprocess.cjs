"use strict";

// Local SYNTHETIC benchmark only. The real HTTP archive route runs in a
// credential-free, provider/crawler-forbidden child. The extracted ingestion
// function uses a fixed synthetic loadRun/observation-builder boundary and the
// real append scanner + durable targeted company queue. It is not a production
// performance measurement or a reconstruction of real provider responses.
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), native = require("node:fs");
const path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), vm = require("node:vm"), readline = require("node:readline");
const { spawn } = require("node:child_process");
const { createCompanyIntegratedDb } = require("./lib/company_integrated_db.cjs");
const { findExistingObservationIds } = require("./lib/history_observation_append.cjs");
const { freePort, request, login, waitUntil, stopChild, executionGuard } = require("./test_collector_integration.cjs");

const ROOT = path.resolve(__dirname, ".."), RUN_COUNT = 500, COMPANY_COUNT = 535, HISTORY_COUNT = 100000, NEW_COMPANIES = 20, DAYS = 21;
const ADMIN = { username: "synthetic-benchmark-admin", password: "synthetic-local-benchmark-password" };
const runId = index => `benchmark_glamping_20261021_${String(index).padStart(6, "0")}`;
const companyId = index => `cmp_place_benchmark_${index}`;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const ms = value => Number(value.toFixed(3));
const source = native.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
function extract(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `Production function ${name} exists`);
  const ending = /\r?\n\}/.exec(source.slice(start + 1)); assert.ok(ending, `${name} boundary`);
  return source.slice(start, start + 1 + ending.index + ending[0].length);
}

function observation(index, incoming = false) {
  const company = incoming ? Math.floor(index / DAYS) : index % COMPANY_COUNT;
  const day = incoming ? index % DAYS : index % 21;
  return { observationId: `${incoming ? "incoming" : "historical"}-${index}`, companyKey: companyId(company),
    companyName: `[SYNTHETIC] Benchmark company ${company}`, runId: incoming ? runId(RUN_COUNT) : runId(index % RUN_COUNT),
    keyword: "[SYNTHETIC] benchmark", stayDate: new Date(Date.UTC(2026, 9, 21 + day)).toISOString().slice(0, 10),
    collectedAt: "2026-10-21T00:00:00.000Z", productType: "lodging", inventoryEvidenceVersion: 4,
    supply: 16, available: 10, sold: 6, publicBookings: 2, phoneBookings: 4,
    publicRevenue: 320000, phoneRevenue: 640000, estimatedRevenue: 960000, missing: false, partial: false };
}

async function saveRun(outputsDir, index) {
  const id = runId(index), directory = path.join(outputsDir, id), csv = "fixture_네이버전체순위.csv";
  await fs.mkdir(directory, { recursive: true });
  const manifest = { schemaVersion: 2, keyword: "[SYNTHETIC] benchmark", collectedAt: new Date(Date.UTC(2026, 9, 21, 0, 0, index)).toISOString(),
    checkIn: "2026-10-21", checkOut: "2026-11-10", searchMode: "keyword", collectionMode: "precision", collectionPurpose: "revenue_detail",
    sourceRole: "admin", collectionSource: "admin_search", dayUseMode: "inspect", productMode: "all", detailRankRanges: "1-20",
    bookingRangeDays: DAYS, bookingRangePlaceLimit: NEW_COMPANIES, workerKey: "web", trigger: "scheduled",
    collectionQuality: { status: "complete" }, files: [csv], fileRoles: { overall: csv }, detailJsonFiles: [],
    counts: { naverOverall: NEW_COMPANIES, naverBookingStockChecked: NEW_COMPANIES, naverBookingStockSucceeded: NEW_COMPANIES,
      naverScheduleRequested: NEW_COMPANIES * DAYS, naverScheduleSucceeded: NEW_COMPANIES * DAYS, naverScheduleFailed: 0, naverScheduleBlocked: 0 } };
  const rows = ["place_id,업체명,전체순위,overall_rank,주소,네이버예약사업자ID,예약,네이버예약재고수집상태"];
  for (let i = 0; i < NEW_COMPANIES; i++) rows.push(`${900000000+i},[SYNTHETIC] Benchmark company ${i},${i+1},${i+1},경상남도 산청군 모의주소,${800000000+i},Y,성공`);
  const contents = { "manifest.json": JSON.stringify(manifest), [csv]: rows.join("\n") + "\n" };
  for (const [name, value] of Object.entries(contents)) await fs.writeFile(path.join(directory, name), value);
  return { id, directory, manifest, hashes: Object.fromEntries(Object.entries(contents).map(([name, value]) => [name, sha(value)])) };
}

async function seed(dataDir) {
  const outputsDir = path.join(dataDir, "outputs"), history = path.join(dataDir, "history", "observations.jsonl");
  const master = { schemaVersion: 1, companies: {} };
  for (let i = 0; i < COMPANY_COUNT; i++) master.companies[companyId(i)] = { companyId: companyId(i), primaryName: `[SYNTHETIC] Benchmark company ${i}`,
    placeIds: [String(900000000+i)], keywords: {}, inventory: {}, manualCorrection: { lodgingBasisTotal: 16 } };
  await fs.mkdir(path.join(dataDir, "company_master"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "company_master", "companies.json"), JSON.stringify(master));
  await fs.mkdir(path.dirname(history), { recursive: true });
  const handle = await fs.open(history, "w");
  try {
    for (let first = 0; first < HISTORY_COUNT; first += 1000) {
      let batch = "";
      for (let i = first; i < Math.min(first + 1000, HISTORY_COUNT); i++) batch += JSON.stringify(observation(i)) + "\n";
      await handle.write(batch);
    }
  } finally { await handle.close(); }
  const runs = [];
  for (let i = 0; i < RUN_COUNT; i++) runs.push(await saveRun(outputsDir, i));
  return { outputsDir, history, masterFile: path.join(dataDir, "company_master", "companies.json"), runs };
}

async function ingestionBenchmark(temporary, data) {
  const incoming = Array.from({ length: NEW_COMPANIES * DAYS }, (_, i) => observation(i, true));
  const ids = Array.from({ length: NEW_COMPANIES }, (_, i) => companyId(i));
  const scans = [], stages = [], calls = { catalog: 0, listTargets: 0, queueCompany: 0, queueRun: 0, sourceLoads: 0, externalRequests: 0 };
  const db = createCompanyIntegratedDb({ dataDir: path.join(temporary, "module-integrated"), autoStart: false,
    loadSources: async () => { calls.sourceLoads++; throw Error("Ingestion admission cannot load analysis sources"); },
    catalog: async () => { calls.catalog++; throw Error("Ingestion admission cannot discover the catalog"); },
    listTargets: async () => { calls.listTargets++; throw Error("Ingestion admission cannot discover all targets"); } });
  const fakeData = { run: { id: runId(RUN_COUNT), collectedAt: "2026-10-21T00:00:00.000Z" }, companyMaster: { activeCompanyIds: ids } };
  const context = vm.createContext({ console: { error: (...args) => { throw Error("Unexpected queue error: " + args[0]); } }, fs: native, fsp: fs,
    HISTORY_DIR: path.dirname(data.history), HISTORY_OBSERVATIONS_FILE: data.history,
    resolveRunDir: () => data.runs[0].directory, readManifest: async () => ({ collectionQuality: { status: "complete" } }), allowsDerivedUpdates: () => true,
    loadRun: async () => fakeData, runCollectionDbRoute: () => ({ appliesHistory: true }), buildHistoryObservations: () => incoming,
    findExistingObservationIds: async options => { const result = await findExistingObservationIds(options); scans.push({ ...result.stats }); return result; },
    masterDbDualWriteQueue: { mode: "off" }, invalidateIndustryAnalysis: async () => {},
    companyIntegratedDb: { queueCompany: async (...args) => { calls.queueCompany++; return db.queueCompany(...args); },
      queueRun: async () => { calls.queueRun++; throw Error("Full target scan forbidden during ingestion"); } },
    Date, Set, Map, fetch: () => { calls.externalRequests++; throw Error("External requests forbidden"); } });
  for (const name of ["queueIntegratedCompanies", "appendHistoryForRunUnlocked"]) vm.runInContext(extract(name), context);
  const durations = [];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = performance.now();
      const result = await context.appendHistoryForRunUnlocked(runId(RUN_COUNT), { skipExternal: true, onStage: (name, elapsedMs) => stages.push({ attempt, name, elapsedMs }) });
      durations.push({ attempt, elapsedMs: ms(performance.now() - started), appended: result.appended, observationCount: result.observationCount });
    }
    assert.equal(durations[0].appended, 420); assert.equal(durations[1].appended, 0);
    assert.equal(calls.queueCompany, NEW_COMPANIES); assert.equal(calls.queueRun, 0);
    assert.equal(calls.catalog, 0); assert.equal(calls.listTargets, 0); assert.equal(calls.sourceLoads, 0); assert.equal(calls.externalRequests, 0);
    assert.ok(scans.every(value => value.maxRetainedIds <= 420 && value.candidateCount === 420));
    const status = await db.status();
    assert.equal(status.jobs.length, NEW_COMPANIES); assert.ok(status.jobs.every(job => job.status === "queued"));
    const storedQueue = JSON.parse(await fs.readFile(path.join(temporary, "module-integrated", "company_integrated", "queue.json"), "utf8"));
    assert.equal(Object.keys(storedQueue.jobs).length, NEW_COMPANIES);
    assert.ok(Object.values(storedQueue.jobs).every(job => job.status === "queued" && job.allMonths));
    const counts = new Map(incoming.map(row => [row.observationId, 0])); let lines = 0;
    const stream = native.createReadStream(data.history, { encoding: "utf8" }), reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try { for await (const line of reader) { if (!line.trim()) continue; lines++; const id = JSON.parse(line).observationId; if (counts.has(id)) counts.set(id, counts.get(id) + 1); } }
    finally { reader.close(); stream.destroy(); }
    assert.equal(lines, HISTORY_COUNT + 420); assert.ok([...counts.values()].every(count => count === 1));
    return { environment: "extracted production ingestion functions; synthetic source load and observation construction; real scanner and durable queue; worker intentionally paused",
      firstAppendAndIdempotentRetry: durations, stageTimings: stages, scans, candidateIdUpperBound: 420,
      queuedAffectedCompanies: status.jobs.length, catalogCallsDuringAdmission: calls.catalog, listTargetsCallsDuringAdmission: calls.listTargets,
      queueRunCallsDuringAdmission: calls.queueRun, finalObservationRows: lines, duplicateIncomingIds: 0, execution: calls };
  } finally { await db.stop(); }
}

async function sequentialArchiveControl(outputsDir, runIds) {
  // A control I/O loop on identical synthetic inputs, not a claim to execute
  // the previous release. It illustrates sequential directory/manifest reads.
  const started = performance.now(); let manifests = 0, directories = 0;
  for (const id of runIds) {
    const dir = path.join(outputsDir, id);
    await fs.readdir(dir); directories++;
    JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")); manifests++;
    await fs.stat(dir);
  }
  return { elapsedMs: ms(performance.now() - started), manifests, directories, environment: "same-input sequential I/O control; not the old full application" };
}

async function main(argv = process.argv.slice(2)) {
  let output = null;
  if (argv.length) { assert.equal(argv.length, 2, "Usage: node scripts/benchmark_collection_postprocess.cjs [--output NEW_FILE.json]"); assert.equal(argv[0], "--output"); output = path.resolve(argv[1]); }
  const temporaryParent = await fs.realpath(os.tmpdir()), temporary = await fs.mkdtemp(path.join(temporaryParent, "collection-postprocess-benchmark-"));
  let child;
  const startedAt = new Date().toISOString(), totalBegan = performance.now();
  try {
    const dataDir = path.join(temporary, "data"), outputsDir = path.join(dataDir, "outputs"), configDir = path.join(dataDir, "config");
    await fs.mkdir(outputsDir, { recursive: true }); await fs.mkdir(configDir, { recursive: true });
    const { guardPath, attemptsPath } = await executionGuard(temporary), port = await freePort(), base = `http://127.0.0.1:${port}`;
    const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE"]
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    Object.assign(env, { NODE_OPTIONS: "", PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, OUTPUTS_DIR: outputsDir, CONFIG_DIR: configDir,
      MASTER_DB_PATH: path.join(dataDir, "master_db", "benchmark.sqlite"), MASTER_DB_WRITE_MODE: "off", SEED_OUTPUTS_FROM_REPO: "0",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", COLLECTOR_EXECUTION_MODE: "worker",
      COLLECTOR_WORKER_TOKEN: "synthetic-benchmark-worker-token-1234567890", GLAMPING_ADMIN_USER: ADMIN.username, GLAMPING_ADMIN_PASSWORD: ADMIN.password,
      GLAMPING_B2B_ENABLED: "0", RENDER_GIT_COMMIT: "local-synthetic-postprocess-benchmark" });
    const logs = [];
    child = spawn(process.execPath, ["--max-old-space-size=512", "--require", guardPath, path.join(ROOT, "scripts/glamping_app_server.cjs")],
      { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    const remember = data => { logs.push(String(data)); if (logs.length > 100) logs.shift(); };
    child.stdout.on("data", remember); child.stderr.on("data", remember);
    await waitUntil(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw Error("Synthetic server startup failed: " + logs.join(""));
      try { return (await request(base, "/api/health")).response.status === 200; } catch { return false; }
    }, "Synthetic benchmark readiness timeout", 30000);
    const cookie = await login(base, ADMIN);
    // Start with empty input so initial background bootstrap is not an
    // uncontrolled full 535-company calculation. Archive traffic is the scope.
    await new Promise(resolve => setTimeout(resolve, 300));
    const seedBegan = performance.now(), data = await seed(dataDir), seedMs = ms(performance.now() - seedBegan);
    const masterBefore = sha(await fs.readFile(data.masterFile));
    const control = await sequentialArchiveControl(outputsDir, data.runs.map(row => row.id));
    async function archiveRead() {
      const began = performance.now(), result = await request(base, "/api/runs", cookie), elapsedMs = ms(performance.now() - began);
      assert.equal(result.response.status, 200, JSON.stringify(result.body)); assert.ok(Array.isArray(result.body.runs));
      return { elapsedMs, rows: result.body.runs };
    }
    const cold = await archiveRead(); assert.equal(cold.rows.length, RUN_COUNT);
    const warm = [];
    for (let i = 0; i < 5; i++) { const result = await archiveRead(); assert.equal(result.rows.length, RUN_COUNT); warm.push(result.elapsedMs); }
    const concurrent = await Promise.all(Array.from({ length: 5 }, archiveRead)); assert.ok(concurrent.every(row => row.rows.length === RUN_COUNT));
    const added = await saveRun(outputsDir, RUN_COUNT), fresh = await archiveRead(); assert.ok(fresh.rows.some(row => row.id === added.id));
    const changedFile = path.join(data.runs[0].directory, "manifest.json"), changed = { ...data.runs[0].manifest, collectionQuality: { status: "blocked", reason: "synthetic_quality_change" } };
    await fs.writeFile(changedFile, JSON.stringify(changed));
    const quality = await archiveRead(); assert.equal(quality.rows.find(row => row.id === data.runs[0].id).collectionQuality.status, "blocked");
    assert.equal(quality.rows.length, RUN_COUNT + 1);
    const ingestion = await ingestionBenchmark(temporary, data);
    // Archived source bytes are unchanged except the explicitly modified
    // synthetic quality fixture; ingestion never opens or rewrites its CSVs.
    let comparedFiles = 0;
    for (const row of data.runs) for (const [name, expected] of Object.entries(row.hashes)) {
      if (row.id === data.runs[0].id && name === "manifest.json") continue;
      assert.equal(sha(await fs.readFile(path.join(row.directory, name))), expected); comparedFiles++;
    }
    assert.equal(sha(await fs.readFile(data.masterFile)), masterBefore);
    assert.equal(await fs.stat(attemptsPath).catch(() => null), null, "No provider, network, crawler or subprocess calls may occur in the server");
    const timings = [cold.elapsedMs, ...warm, ...concurrent.map(row => row.elapsedMs)];
    const result = { status: "passed", startedAt, finishedAt: new Date().toISOString(), elapsedMs: ms(performance.now() - totalBegan),
      environment: "local synthetic fixture, real HTTP archive endpoint plus isolated production-function ingestion replay", productionTiming: false, operatingDataUsed: false,
      fixture: { savedRuns: RUN_COUNT, companies: COMPANY_COUNT, historicalRows: HISTORY_COUNT, newCompanies: NEW_COMPANIES, newStayDatesPerCompany: DAYS, newObservationRows: 420, seedMs },
      archive: { endpoint: "GET /api/runs", timingIncludes: "local HTTP request, JSON response download and parse; no browser paint measurement",
        coldMs: cold.elapsedMs, warmMs: warm, concurrentFiveMs: concurrent.map(row => row.elapsedMs),
        targetMs: 2000, allMeasuredReadsUnderTarget: timings.every(value => value <= 2000), maximumMs: Math.max(...timings),
        newRunImmediatelyVisible: true, newRunLookupMs: fresh.elapsedMs, changedQualityImmediatelyVisible: true, changedQualityLookupMs: quality.elapsedMs,
        sequentialInputIOControl: control },
      ingestion, fixturePreservation: { preexistingSyntheticArchiveFilesUnchanged: comparedFiles, syntheticMasterUnchanged: true, expectedQualityMutationExcluded: 1 },
      guard: { serverExternalAttempts: 0, workerExecutions: 0, productionCredentialsInherited: false },
      limitations: ["All observations, companies and source files are synthetic; no operating originals or real customer data were used.",
        "Initial app startup is empty before the synthetic fixture is seeded; full-company startup/recalculation is not this benchmark's scope.",
        "Ingestion replays extracted production append/admission functions, with synthetic loadRun and observation-builder stubs; product parser performance is not measured.",
        "Affected company jobs are durably admitted with the worker paused; background aggregate completion is not claimed.",
        "Local timings are not production or browser-render timings, and an I/O control is not a previous-release benchmark."] };
    if (output) { await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" }); }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result;
  } finally {
    await stopChild(child);
    const actual = await fs.realpath(temporary);
    assert.equal(path.dirname(actual), temporaryParent); assert.ok(path.basename(actual).startsWith("collection-postprocess-benchmark-"));
    await fs.rm(actual, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { main };
