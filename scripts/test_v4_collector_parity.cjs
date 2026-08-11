const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  EXPECTED_COLLECTOR_BLOB,
  JOB_SCHEMA,
  ORIGINAL_COLLECTOR,
  executeJob,
  gitBlobSha,
  publicFailure
} = require("./v4_worker_once.cjs");
const {
  ensureParityRoot,
  executeParity,
  executeSuite
} = require("./v4_collector_parity.cjs");
const { validateSuiteReport } = require("./v4_parity_shadow_host.cjs");

const ROOT = path.resolve(__dirname, "..");
const PARITY_RUNNER = path.join(__dirname, "v4_collector_parity.cjs");
const NETWORK_BLOCKER = path.join(__dirname, "fixtures", "v4_network_blocker.cjs");
const FIXTURE_TRANSPORT = path.join(__dirname, "fixtures", "v4_collector_fixture_transport.cjs");
const TEST_SECRET = "phase7-parity-private-secret-value";

function baseJob(suffix = "suite") {
  return {
    schemaVersion: JOB_SCHEMA,
    jobId: `phase7-${suffix}`,
    idempotencyKey: `phase7-key-${suffix}`,
    keyword: "Gyeongnam glamping offline parity fixture",
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

function withTemporaryEnv(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
}

async function allFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await visit(root);
  return files;
}

async function assertSecretAbsent(root) {
  const needle = Buffer.from(TEST_SECRET, "utf8");
  for (const file of await allFiles(root)) {
    const value = await fsp.readFile(file);
    assert.equal(value.includes(needle), false, `secret leaked to ${file}`);
  }
}

function runNode(args, env = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "datalab-v4-parity-"));
  try {
    assert.equal(await gitBlobSha(ORIGINAL_COLLECTOR), EXPECTED_COLLECTOR_BLOB);

    await withTemporaryEnv({ V4_PARITY_PRIVATE_SECRET: TEST_SECRET }, async () => {
      const suiteRoot = path.join(temp, "suite-root");
      const suite = await executeSuite(baseJob(), suiteRoot);
      assert.equal(suite.report.allBehavioralComparisonsMatched, true);
      assert.equal(suite.report.actualExternalRequests, 0);
      assert.equal(suite.report.operationalWrites, false);
      assert.equal(suite.report.idempotencyReplay.status, "duplicate");
      assert.equal(suite.report.idempotencyReplay.code, "IDEMPOTENT_REPLAY");
      assert.deepEqual(validateSuiteReport(suite.report), {
        matched: true,
        actualExternalRequests: 0,
        operationalWrites: false,
        scenarioCount: 7
      });
      assert.throws(
        () => validateSuiteReport({
          ...suite.report,
          scenarios: suite.report.scenarios.map((item, index) => index ? item : { ...item, matched: false })
        }),
        (error) => error.code === "PARITY_HOST_REPORT_INVALID"
      );

      const scenarios = new Map(suite.report.scenarios.map((item) => [item.scenario, item]));
      for (const name of ["success", "empty", "duplicate", "missing-field", "booking", "provider-error", "timeout"]) {
        assert.equal(scenarios.get(name)?.matched, true, `${name} parity mismatch`);
        assert.equal(scenarios.get(name)?.actualExternalRequests, 0, `${name} external request detected`);
      }
      assert.ok(scenarios.get("duplicate").duplicateRowsRetained > 0);
      assert.equal(scenarios.get("provider-error").workerCode, "COLLECTOR_EXIT_NONZERO");
      assert.equal(scenarios.get("timeout").workerCode, "COLLECTOR_TIMEOUT");

      for (const reportFile of (await allFiles(path.join(suiteRoot, "reports"))).filter((file) => file.endsWith(".json"))) {
        const report = JSON.parse(await fsp.readFile(reportFile, "utf8"));
        if (!report.scenario) continue;
        assert.equal(report.collectorInvocations.reference, 1);
        assert.equal(report.collectorInvocations.worker, 1);
        assert.equal(report.networkIsolation.actualExternalRequests, 0);
        assert.equal(report.operationalWrites, false);
        assert.equal(report.collectorBlobBefore, EXPECTED_COLLECTOR_BLOB);
        assert.equal(report.collectorBlobAfter, EXPECTED_COLLECTOR_BLOB);
      }

      await assertSecretAbsent(suiteRoot);
    });

    await withTemporaryEnv({
      NODE_ENV: "test",
      V4_WORKER_ALLOW_OFFLINE_FIXTURE: "1",
      V4_WORKER_OFFLINE_NETWORK_BLOCKER: "1",
      V4_WORKER_PRIVATE_SECRET: TEST_SECRET
    }, async () => {
      const partialRoot = path.join(temp, "partial-root");
      let failure;
      try {
        await executeJob(baseJob("partial"), { dataRoot: partialRoot, fixtureScenario: "partial" });
      } catch (error) {
        failure = publicFailure(error, "phase7-partial");
      }
      assert.equal(failure.code, "COLLECTOR_EXIT_NONZERO");
      assert.deepEqual(await fsp.readdir(path.join(partialRoot, "work")), []);
      assert.deepEqual(await fsp.readdir(path.join(partialRoot, "artifacts")), []);
      await assertSecretAbsent(partialRoot);
    });

    const escape = path.join(temp, "forbidden-output");
    await assert.rejects(
      executeParity({ ...baseJob("invalid"), outputsDir: escape }, {
        root: path.join(temp, "invalid-job-root"),
        scenario: "success"
      }),
      (error) => error.code === "JOB_SPEC_UNKNOWN_FIELD"
    );
    assert.equal(fs.existsSync(escape), false);

    const unsafeRoot = path.join(ROOT, ".phase7-unsafe-parity-root");
    await assert.rejects(
      ensureParityRoot(unsafeRoot),
      (error) => error.code === "PARITY_ROOT_UNSAFE"
    );
    assert.equal(fs.existsSync(unsafeRoot), false);

    const pathConfig = path.join(temp, "path-probe-config");
    await fsp.mkdir(pathConfig, { recursive: true });
    const outsideTrace = path.join(temp, "outside-trace.json");
    const pathProbe = runNode([
      "-e",
      `try { require(${JSON.stringify(FIXTURE_TRANSPORT)}); } catch (error) { process.stdout.write(error.code || "UNKNOWN"); }`
    ], {
      CONFIG_DIR: pathConfig,
      V4_PARITY_TRACE_FILE: outsideTrace,
      V4_PARITY_FIXTURE_SCENARIO: "success"
    });
    assert.equal(pathProbe.status, 0);
    assert.equal(pathProbe.stdout, "V4_PARITY_TRACE_PATH_INVALID");
    assert.equal(fs.existsSync(outsideTrace), false);

    const fetchConfig = path.join(temp, "fetch-probe-config");
    const fetchTrace = path.join(fetchConfig, "trace.json");
    await fsp.mkdir(fetchConfig, { recursive: true });
    const fetchProbe = runNode([
      "-e",
      `require(${JSON.stringify(FIXTURE_TRANSPORT)}); fetch("https://example.com/not-registered").catch((error) => process.stdout.write(error.code || "UNKNOWN"));`
    ], {
      CONFIG_DIR: fetchConfig,
      V4_PARITY_TRACE_FILE: fetchTrace,
      V4_PARITY_FIXTURE_SCENARIO: "success"
    });
    assert.equal(fetchProbe.status, 0);
    assert.equal(fetchProbe.stdout, "V4_PARITY_FIXTURE_UNHANDLED_URL");
    const fetchEvidence = JSON.parse(await fsp.readFile(fetchTrace, "utf8"));
    assert.equal(fetchEvidence.actualExternalRequests, 0);
    assert.equal(fetchEvidence.routes[0].outcome, "blocked-unhandled-route");

    const socketConfig = path.join(temp, "socket-probe-config");
    const socketTrace = path.join(socketConfig, "trace.json");
    await fsp.mkdir(socketConfig, { recursive: true });
    const socketProbe = runNode([
      "-e",
      `require(${JSON.stringify(FIXTURE_TRANSPORT)}); try { require("node:https").get("https://example.com"); } catch (error) { process.stdout.write(error.code || "UNKNOWN"); }`
    ], {
      CONFIG_DIR: socketConfig,
      V4_PARITY_TRACE_FILE: socketTrace,
      V4_PARITY_FIXTURE_SCENARIO: "success"
    });
    assert.equal(socketProbe.status, 0);
    assert.equal(socketProbe.stdout, "V4_OFFLINE_NETWORK_BLOCKED");

    const cliRoot = path.join(temp, "cli-root");
    const jobFile = path.join(ROOT, "tests", "fixtures", "v4_collector_parity_job.json");
    const cli = runNode([
      "--require",
      NETWORK_BLOCKER,
      PARITY_RUNNER,
      "--job-file",
      jobFile,
      "--root",
      cliRoot,
      "--scenario",
      "empty"
    ], { V4_PARITY_PRIVATE_SECRET: TEST_SECRET });
    const stdoutLines = String(cli.stdout || "").trim().split(/\r?\n/).filter(Boolean);
    assert.equal(cli.status, 0);
    assert.equal(stdoutLines.length, 1);
    assert.equal(JSON.parse(stdoutLines[0]).actualExternalRequests, 0);
    assert.equal(String(cli.stdout).includes(TEST_SECRET), false);
    assert.equal(String(cli.stderr).includes(TEST_SECRET), false);
    await assertSecretAbsent(cliRoot);

    assert.equal(await gitBlobSha(ORIGINAL_COLLECTOR), EXPECTED_COLLECTOR_BLOB);
    process.stdout.write("V4 collector parity offline tests passed\n");
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
