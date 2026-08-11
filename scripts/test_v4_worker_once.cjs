const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const {
  EXPECTED_COLLECTOR_BLOB,
  JOB_SCHEMA,
  gitBlobSha
} = require("./v4_worker_once.cjs");

const ROOT = path.resolve(__dirname, "..");
const WORKER = path.join(__dirname, "v4_worker_once.cjs");
const COLLECTOR = path.join(__dirname, "gyeongnam_glamping_crawl.cjs");
const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "v4_worker_manifest_golden.json"), "utf8"));
const TEST_SECRET = "v4-fixture-super-secret-value";

function baseJob(suffix = "one") {
  return {
    schemaVersion: JOB_SCHEMA,
    jobId: `offline-${suffix}`,
    idempotencyKey: `offline-key-${suffix}`,
    keyword: "Gyeongnam glamping",
    checkIn: "2026-08-12",
    checkOut: "2026-08-18",
    adults: 2,
    searchMode: "keyword",
    productMode: "all",
    collectionMode: "precision",
    collectionPurpose: "revenue_detail",
    detailRankRanges: "1-10",
    bookingRangeDays: 7,
    bookingRangePlaceLimit: 10
  };
}

function runCli(job, dataRoot, scenario = "success") {
  return runWorkerProcess([`--offline-fixture=${scenario}`], dataRoot, JSON.stringify(job));
}

function runWorkerProcess(args, dataRoot, input) {
  const result = spawnSync(process.execPath, [WORKER, ...args], {
    cwd: ROOT,
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      V4_WORKER_ALLOW_OFFLINE_FIXTURE: "1",
      V4_WORKER_DATA_DIR: dataRoot,
      V4_WORKER_PRIVATE_SECRET: TEST_SECRET
    }
  });
  const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `worker stdout must contain one JSON line: ${result.stdout}`);
  assert.equal(String(result.stdout).includes(TEST_SECRET), false);
  assert.equal(String(result.stderr).includes(TEST_SECRET), false);
  const parsed = JSON.parse(lines[0]);
  assert.equal(JSON.stringify(parsed).includes(TEST_SECRET), false);
  return { process: result, result: parsed };
}

function runWorkerProcessAsync(job, dataRoot, scenario) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, `--offline-fixture=${scenario}`], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: "test",
        V4_WORKER_ALLOW_OFFLINE_FIXTURE: "1",
        V4_WORKER_DATA_DIR: dataRoot,
        V4_WORKER_PRIVATE_SECRET: TEST_SECRET
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        assert.equal(lines.length, 1);
        assert.equal(stdout.includes(TEST_SECRET), false);
        assert.equal(stderr.includes(TEST_SECRET), false);
        resolve({ status: code, result: JSON.parse(lines[0]) });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(job));
  });
}

function sortedKeys(value) {
  return Object.keys(value || {}).sort();
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "datalab-v4-worker-"));
  try {
    assert.equal(await gitBlobSha(COLLECTOR), EXPECTED_COLLECTOR_BLOB);

    const successRoot = path.join(tmp, "success-root");
    const first = runCli(baseJob("success"), successRoot);
    assert.equal(first.process.status, 0);
    assert.equal(first.result.status, "succeeded");
    assert.equal(first.result.code, "OK");
    assert.equal(first.result.duplicate, false);
    assert.ok(path.resolve(first.result.artifactDir).startsWith(path.resolve(successRoot) + path.sep));
    assert.equal(fs.existsSync(path.join(first.result.artifactDir, "worker-envelope.json")), true);

    const manifest = JSON.parse(await fsp.readFile(path.join(first.result.artifactDir, "manifest.json"), "utf8"));
    assert.deepEqual(sortedKeys(manifest), GOLDEN.manifestTopLevelKeys);
    assert.deepEqual(sortedKeys(manifest.collectionProfileFlags), GOLDEN.collectionProfileFlagKeys);
    assert.deepEqual(sortedKeys(manifest.fileRoles), GOLDEN.fileRoleKeys);
    assert.deepEqual(sortedKeys(manifest.counts), GOLDEN.countKeys);

    const jobFile = path.join(tmp, "job-file.json");
    await fsp.writeFile(jobFile, `${JSON.stringify(baseJob("job-file"))}\n`, "utf8");
    const fromFile = runWorkerProcess(
      ["--job-file", jobFile, "--offline-fixture=success"],
      path.join(tmp, "job-file-root"),
      undefined
    );
    assert.equal(fromFile.process.status, 0);
    assert.equal(fromFile.result.status, "succeeded");

    const originalSource = await fsp.readFile(COLLECTOR, "utf8");
    for (const key of GOLDEN.manifestTopLevelKeys) {
      assert.match(originalSource, new RegExp(`\\b${key}\\s*(?::|,)`), `original manifest key missing from source: ${key}`);
    }
    for (const key of GOLDEN.fileRoleKeys) {
      assert.match(originalSource, new RegExp(`\\b${key}\\s*:`), `original file role missing from source: ${key}`);
    }

    const replay = runCli(baseJob("success"), successRoot);
    assert.equal(replay.process.status, 0);
    assert.equal(replay.result.status, "duplicate");
    assert.equal(replay.result.code, "IDEMPOTENT_REPLAY");
    assert.equal(replay.result.artifactId, first.result.artifactId);
    assert.equal((await fsp.readdir(path.join(successRoot, "artifacts"))).length, 1);

    await fsp.unlink(path.join(successRoot, "idempotency", `${first.result.idempotencyKeyHash}.json`));
    const recoveredReplay = runCli(baseJob("success"), successRoot);
    assert.equal(recoveredReplay.process.status, 0);
    assert.equal(recoveredReplay.result.status, "duplicate");
    assert.equal(recoveredReplay.result.artifactId, first.result.artifactId);
    assert.equal(fs.existsSync(path.join(successRoot, "idempotency", `${first.result.idempotencyKeyHash}.json`)), true);

    const concurrentRoot = path.join(tmp, "concurrent-root");
    const concurrentJob = baseJob("concurrent");
    const firstConcurrent = runWorkerProcessAsync(concurrentJob, concurrentRoot, "slow");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const secondConcurrent = runWorkerProcessAsync(concurrentJob, concurrentRoot, "slow");
    const concurrentResults = await Promise.all([firstConcurrent, secondConcurrent]);
    assert.equal(concurrentResults.filter((item) => item.result.status === "succeeded").length, 1);
    assert.equal(concurrentResults.filter((item) => item.result.code === "IDEMPOTENCY_IN_PROGRESS").length, 1);
    assert.equal((await fsp.readdir(path.join(concurrentRoot, "artifacts"))).length, 1);

    const conflictJob = { ...baseJob("success"), keyword: "Different keyword" };
    const conflict = runCli(conflictJob, successRoot);
    assert.notEqual(conflict.process.status, 0);
    assert.equal(conflict.result.code, "IDEMPOTENCY_CONFLICT");

    const invalid = runCli({ ...baseJob("invalid"), outputsDir: path.join(tmp, "escape") }, path.join(tmp, "invalid-root"));
    assert.notEqual(invalid.process.status, 0);
    assert.equal(invalid.result.code, "JOB_SPEC_UNKNOWN_FIELD");
    assert.equal(fs.existsSync(path.join(tmp, "escape")), false);

    const exitRoot = path.join(tmp, "exit-root");
    const exited = runCli(baseJob("exit"), exitRoot, "exit");
    assert.notEqual(exited.process.status, 0);
    assert.equal(exited.result.code, "COLLECTOR_EXIT_NONZERO");
    assert.equal(exited.result.exitCode, 7);
    assert.deepEqual(await fsp.readdir(path.join(exitRoot, "work")), []);

    const failedReplay = runCli(baseJob("exit"), exitRoot, "success");
    assert.notEqual(failedReplay.process.status, 0);
    assert.equal(failedReplay.result.code, "IDEMPOTENCY_PREVIOUS_FAILURE");

    const partialRoot = path.join(tmp, "partial-root");
    const partial = runCli(baseJob("partial"), partialRoot, "partial");
    assert.notEqual(partial.process.status, 0);
    assert.equal(partial.result.code, "COLLECTOR_EXIT_NONZERO");
    assert.deepEqual(await fsp.readdir(path.join(partialRoot, "work")), []);
    assert.deepEqual(await fsp.readdir(path.join(partialRoot, "artifacts")), []);

    const missing = runCli(baseJob("missing"), path.join(tmp, "missing-root"), "missing-file");
    assert.notEqual(missing.process.status, 0);
    assert.equal(missing.result.code, "ARTIFACT_FILE_MISSING");

    const outside = runCli(baseJob("outside"), path.join(tmp, "outside-root"), "manifest-outside");
    assert.notEqual(outside.process.status, 0);
    assert.equal(outside.result.code, "ARTIFACT_MANIFEST_PATH_INVALID");

    const unsafeRoot = path.join(ROOT, "outputs", "v4-worker-test");
    const unsafe = runCli(baseJob("unsafe"), unsafeRoot);
    assert.notEqual(unsafe.process.status, 0);
    assert.equal(unsafe.result.code, "DATA_ROOT_UNSAFE");
    assert.equal(fs.existsSync(unsafeRoot), false);

    assert.equal(await gitBlobSha(COLLECTOR), EXPECTED_COLLECTOR_BLOB);
    process.stdout.write("V4 worker offline tests passed\n");
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
