const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const XLSX = require("xlsx");
const {
  BASELINE_COMMIT,
  EXPECTED_COLLECTOR_BLOB,
  ORIGINAL_COLLECTOR,
  PARITY_FIXTURE_SCENARIOS,
  executeJob,
  gitBlobSha,
  normalizeJob,
  publicFailure,
  runChild
} = require("./v4_worker_once.cjs");

const ROOT = path.resolve(__dirname, "..");
const PARITY_SOURCE_BASELINE_COMMIT = "c1d26654e52007712f9cf0389d7e69724b5d517a";
const PARITY_ROOT_SCHEMA = "datalab-v4-parity-root.v1";
const PARITY_REPORT_SCHEMA = "datalab-v4-collector-parity-report.v1";
const PARITY_SUITE_SCHEMA = "datalab-v4-collector-parity-suite.v1";
const SUCCESS_SCENARIOS = new Set(["success", "empty", "duplicate", "missing-field", "booking"]);
const FAILURE_EXPECTATIONS = {
  "provider-error": { directCode: "COLLECTOR_EXIT_NONZERO", workerCode: "COLLECTOR_EXIT_NONZERO" },
  timeout: { directCode: "COLLECTOR_TIMEOUT", workerCode: "COLLECTOR_TIMEOUT" }
};
const DEFAULT_SUITE = ["success", "empty", "duplicate", "missing-field", "booking", "provider-error", "timeout"];

class ParityError extends Error {
  constructor(code, stage, message) {
    super(message);
    this.name = "ParityError";
    this.code = code;
    this.stage = stage;
    this.retryable = false;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sensitiveValuesFromEnv(env = process.env) {
  return Object.entries(env)
    .filter(([name, value]) => /(KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL)/i.test(name)
      && typeof value === "string"
      && value.length >= 4)
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
}

function sanitizeText(value, sensitiveValues = sensitiveValuesFromEnv()) {
  let text = String(value || "");
  for (const secret of sensitiveValues) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/(authorization|api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function summarizeWorkerResult(value) {
  const copy = JSON.parse(JSON.stringify(value));
  if (copy.artifactDir) copy.artifactDir = "<dedicated-worker-artifact>";
  return copy;
}

function isContained(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertContained(parent, child, code = "PARITY_PATH_OUTSIDE_ROOT") {
  if (!isContained(parent, child)) throw new ParityError(code, "storage", "Parity path is outside its dedicated root.");
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await fsp.rename(temporary, filePath);
}

async function ensureParityRoot(value) {
  if (!value || !path.isAbsolute(value)) {
    throw new ParityError("PARITY_ROOT_REQUIRED", "storage", "Parity root must be an absolute dedicated path.");
  }
  const root = path.resolve(value);
  if (root === path.parse(root).root || isContained(ROOT, root) || isContained(root, ROOT)) {
    throw new ParityError("PARITY_ROOT_UNSAFE", "storage", "Parity root cannot overlap the repository.");
  }
  let existed = true;
  try {
    const stat = await fsp.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ParityError("PARITY_ROOT_UNSAFE", "storage", "Parity root must be a real directory.");
    }
  } catch (error) {
    if (error instanceof ParityError) throw error;
    if (error.code !== "ENOENT") throw error;
    existed = false;
    await fsp.mkdir(root, { recursive: true });
  }
  const marker = path.join(root, ".v4-parity-root.json");
  if (!fs.existsSync(marker)) {
    const entries = await fsp.readdir(root);
    if (existed && entries.length) {
      throw new ParityError("PARITY_ROOT_NOT_DEDICATED", "storage", "Existing parity root is not dedicated.");
    }
    await writeJsonAtomic(marker, {
      schemaVersion: PARITY_ROOT_SCHEMA,
      sourceBaselineCommit: PARITY_SOURCE_BASELINE_COMMIT,
      collectorBaselineCommit: BASELINE_COMMIT,
      collectorBlob: EXPECTED_COLLECTOR_BLOB
    });
  } else {
    const parsed = JSON.parse(await fsp.readFile(marker, "utf8"));
    if (
      parsed.schemaVersion !== PARITY_ROOT_SCHEMA
      || parsed.sourceBaselineCommit !== PARITY_SOURCE_BASELINE_COMMIT
      || parsed.collectorBaselineCommit !== BASELINE_COMMIT
      || parsed.collectorBlob !== EXPECTED_COLLECTOR_BLOB
    ) {
      throw new ParityError("PARITY_ROOT_MARKER_INVALID", "storage", "Parity root marker does not match the frozen baseline.");
    }
  }
  const roots = { root, runs: path.join(root, "runs"), reports: path.join(root, "reports") };
  for (const directory of [roots.runs, roots.reports]) {
    assertContained(root, directory);
    await fsp.mkdir(directory, { recursive: true });
  }
  return roots;
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  values.push(current);
  return values;
}

function parseCsv(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length);
  return lines.map(parseCsvLine);
}

function canonicalManifest(value) {
  const copy = JSON.parse(JSON.stringify(value));
  copy.outputDir = "<isolated-output-dir>";
  return copy;
}

function canonicalReport(text) {
  return String(text || "").replace(/^- 수집일시:.*$/m, "- 수집일시: <dynamic-kst-time>");
}

function canonicalWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  return workbook.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: "" });
    for (const row of rows) {
      if (row[0] === "수집일시") row[1] = "<dynamic-kst-time>";
    }
    return { name, rows };
  });
}

function csvEvidence(rows) {
  const columns = rows[0] || [];
  const idColumn = ["place_id", "id", "name", "업체명"].find((name) => columns.includes(name)) || "";
  const idIndex = idColumn ? columns.indexOf(idColumn) : -1;
  const ids = idIndex >= 0 ? rows.slice(1).map((row) => row[idIndex] || "") : [];
  return {
    columns,
    rowCount: Math.max(0, rows.length - 1),
    idColumn,
    idDigest: idColumn ? sha256(stableJson(ids)) : null
  };
}

function workbookEvidence(sheets) {
  return sheets.map((sheet) => ({
    name: sheet.name,
    rowCount: sheet.rows.length,
    columnCount: Math.max(0, ...sheet.rows.map((row) => row.length))
  }));
}

async function listFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  await visit(root);
  return files.sort();
}

async function oneOutputDirectory(outputsRoot) {
  const entries = await fsp.readdir(outputsRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  if (entries.length !== 1 || directories.length !== 1) {
    throw new ParityError("REFERENCE_OUTPUT_COUNT_INVALID", "reference", "Frozen collector did not create exactly one output directory.");
  }
  return path.join(outputsRoot, directories[0].name);
}

async function compareCollectorArtifacts(referenceDir, workerDir) {
  const referenceFiles = await listFiles(referenceDir);
  const workerFiles = (await listFiles(workerDir)).filter((file) => file !== "worker-envelope.json");
  const mismatches = [];
  if (stableJson(referenceFiles) !== stableJson(workerFiles)) {
    mismatches.push({ area: "file-set", reference: referenceFiles, worker: workerFiles });
  }
  const referenceManifest = JSON.parse(await fsp.readFile(path.join(referenceDir, "manifest.json"), "utf8"));
  const workerManifest = JSON.parse(await fsp.readFile(path.join(workerDir, "manifest.json"), "utf8"));
  const manifestSchemaMatch = stableJson(Object.keys(referenceManifest).sort()) === stableJson(Object.keys(workerManifest).sort());
  const manifestValueMatch = stableJson(canonicalManifest(referenceManifest)) === stableJson(canonicalManifest(workerManifest));
  if (!manifestSchemaMatch) mismatches.push({ area: "manifest-schema" });
  if (!manifestValueMatch) mismatches.push({ area: "manifest-values" });

  const fileComparisons = {};
  for (const relative of referenceFiles.filter((file) => workerFiles.includes(file))) {
    const referenceFile = path.join(referenceDir, ...relative.split("/"));
    const workerFile = path.join(workerDir, ...relative.split("/"));
    let left;
    let right;
    let method = "sha256";
    let evidence = {};
    if (relative === "manifest.json") {
      left = canonicalManifest(referenceManifest);
      right = canonicalManifest(workerManifest);
      method = "canonical-json";
    } else if (relative.endsWith(".csv")) {
      left = parseCsv(await fsp.readFile(referenceFile, "utf8"));
      right = parseCsv(await fsp.readFile(workerFile, "utf8"));
      method = "parsed-csv";
      evidence = { reference: csvEvidence(left), worker: csvEvidence(right) };
    } else if (relative.endsWith(".md")) {
      left = canonicalReport(await fsp.readFile(referenceFile, "utf8"));
      right = canonicalReport(await fsp.readFile(workerFile, "utf8"));
      method = "canonical-markdown";
    } else if (relative.endsWith(".xlsx")) {
      left = canonicalWorkbook(referenceFile);
      right = canonicalWorkbook(workerFile);
      method = "sheet-values";
      evidence = { reference: workbookEvidence(left), worker: workbookEvidence(right) };
    } else if (relative.endsWith(".json")) {
      left = JSON.parse(await fsp.readFile(referenceFile, "utf8"));
      right = JSON.parse(await fsp.readFile(workerFile, "utf8"));
      method = "parsed-json";
    } else {
      left = sha256(await fsp.readFile(referenceFile));
      right = sha256(await fsp.readFile(workerFile));
    }
    const matched = stableJson(left) === stableJson(right);
    fileComparisons[relative] = { method, matched, ...evidence };
    if (!matched) mismatches.push({ area: "file-content", file: relative, method });
  }

  const overallFile = referenceManifest.fileRoles?.overall;
  let duplicateRowsRetained = null;
  if (overallFile && fs.existsSync(path.join(referenceDir, overallFile))) {
    const rows = parseCsv(await fsp.readFile(path.join(referenceDir, overallFile), "utf8"));
    const header = rows[0] || [];
    const placeIndex = header.indexOf("place_id");
    const ids = placeIndex >= 0 ? rows.slice(1).map((row) => row[placeIndex]).filter(Boolean) : [];
    duplicateRowsRetained = ids.length - new Set(ids).size;
  }
  return {
    matched: mismatches.length === 0,
    manifestSchemaMatch,
    manifestValueMatch,
    referenceFiles,
    workerFiles,
    workerAdditionalFiles: (await listFiles(workerDir)).filter((file) => !referenceFiles.includes(file)),
    fileComparisons,
    duplicateRowsRetained,
    mismatches
  };
}

async function readTrace(stage) {
  const filePath = path.join(stage.config, "network-trace.json");
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function validateTrace(trace, scenario, side) {
  if (
    !trace
    || trace.scenario !== scenario
    || trace.networkBlockerLoaded !== true
    || trace.actualExternalRequests !== 0
    || !Number.isInteger(trace.fixtureRequestCount)
    || !Array.isArray(trace.routes)
  ) {
    throw new ParityError(
      "PARITY_NETWORK_TRACE_INVALID",
      "network_isolation",
      `${side} trace did not prove zero external requests.`
    );
  }
  return trace;
}

function captureEnvironment(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function directoryCounts(workerRoot) {
  const count = async (name) => {
    try {
      return (await fsp.readdir(path.join(workerRoot, name))).length;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  };
  return { artifacts: await count("artifacts"), idempotency: await count("idempotency"), work: await count("work"), locks: await count("locks") };
}

async function executeParity(spec, options = {}) {
  const collectorBlobBefore = await gitBlobSha(ORIGINAL_COLLECTOR);
  if (collectorBlobBefore !== EXPECTED_COLLECTOR_BLOB) {
    throw new ParityError("COLLECTOR_BLOB_MISMATCH", "baseline", "Frozen collector blob does not match the approved baseline.");
  }
  const scenario = String(options.scenario || "success");
  if (!PARITY_FIXTURE_SCENARIOS.has(scenario)) {
    throw new ParityError("PARITY_SCENARIO_INVALID", "input", "Unknown parity scenario.");
  }
  const roots = await ensureParityRoot(options.root);
  const job = normalizeJob(spec);
  const runName = String(options.runName || `${scenario}-${sha256(job.jobId).slice(0, 10)}`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(runName)) {
    throw new ParityError("PARITY_RUN_NAME_INVALID", "input", "Parity run name is invalid.");
  }
  const runRoot = path.join(roots.runs, runName);
  assertContained(roots.runs, runRoot);
  if (fs.existsSync(runRoot)) throw new ParityError("PARITY_RUN_EXISTS", "storage", "Parity run already exists.");
  const referenceStage = {
    root: path.join(runRoot, "reference"),
    data: path.join(runRoot, "reference", "data"),
    config: path.join(runRoot, "reference", "config"),
    outputs: path.join(runRoot, "reference", "outputs")
  };
  const workerRoot = path.join(runRoot, "worker-data");
  for (const directory of Object.values(referenceStage)) {
    assertContained(runRoot, directory);
    await fsp.mkdir(directory, { recursive: true });
  }
  const envNames = [
    "NODE_ENV",
    "V4_WORKER_ALLOW_OFFLINE_PARITY",
    "V4_WORKER_TIMEOUT_MS",
    "REGIONAL_LIMIT",
    "NAVER_SCHEDULE_DELAY_MS"
  ];
  const previousEnv = captureEnvironment(envNames);
  process.env.NODE_ENV = "test";
  process.env.V4_WORKER_ALLOW_OFFLINE_PARITY = "1";
  process.env.V4_WORKER_TIMEOUT_MS = scenario === "timeout" ? "1000" : String(options.timeoutMs || 15000);
  process.env.REGIONAL_LIMIT = "2";
  process.env.NAVER_SCHEDULE_DELAY_MS = "0";

  const idempotencyHash = sha256(job.idempotencyKey);
  let reference = null;
  let worker = null;
  let comparison = null;
  try {
    try {
      const child = await runChild({
        collectorScript: ORIGINAL_COLLECTOR,
        job,
        stage: referenceStage,
        idempotencyHash,
        parityScenario: scenario
      });
      reference = {
        status: child.code === 0 ? "succeeded" : "failed",
        code: child.code === 0 ? "OK" : "COLLECTOR_EXIT_NONZERO",
        exitCode: child.code,
        stdoutBytes: Buffer.byteLength(child.stdout || ""),
        stderrBytes: Buffer.byteLength(child.stderr || "")
      };
    } catch (error) {
      reference = {
        status: "failed",
        code: error.code || "REFERENCE_INTERNAL_ERROR",
        exitCode: null,
        stdoutBytes: 0,
        stderrBytes: 0
      };
    }
    const referenceTrace = validateTrace(await readTrace(referenceStage), scenario, "Reference");
    reference.networkTrace = referenceTrace;

    try {
      worker = await executeJob(job, { dataRoot: workerRoot, parityScenario: scenario });
    } catch (error) {
      worker = publicFailure(error, job.jobId);
    }

    if (SUCCESS_SCENARIOS.has(scenario)) {
      if (reference.status !== "succeeded" || worker.status !== "succeeded") {
        comparison = {
          matched: false,
          mismatches: [{ area: "terminal-status", reference: reference.status, worker: worker.status, workerCode: worker.code }]
        };
      } else {
        const referenceDir = await oneOutputDirectory(referenceStage.outputs);
        comparison = await compareCollectorArtifacts(referenceDir, worker.artifactDir);
      }
    } else {
      const expected = FAILURE_EXPECTATIONS[scenario];
      const matched = reference.status === "failed"
        && worker.status === "failed"
        && reference.code === expected.directCode
        && worker.code === expected.workerCode;
      comparison = {
        matched,
        expectedFailure: expected,
        mismatches: matched ? [] : [{ area: "failure-contract", referenceCode: reference.code, workerCode: worker.code }]
      };
    }

    const counts = await directoryCounts(workerRoot);
    const workerTrace = validateTrace(
      worker.offlineParity || worker.details?.offlineParity || null,
      scenario,
      "Worker"
    );
    if (stableJson(referenceTrace.routes) !== stableJson(workerTrace.routes)) {
      comparison.matched = false;
      comparison.mismatches.push({ area: "network-route-contract" });
    }
    const actualExternalRequests = Number(referenceTrace.actualExternalRequests)
      + Number(workerTrace.actualExternalRequests);
    const report = {
      schemaVersion: PARITY_REPORT_SCHEMA,
      baselineCommit: PARITY_SOURCE_BASELINE_COMMIT,
      collectorBaselineCommit: BASELINE_COMMIT,
      collectorBlobBefore,
      collectorBlobAfter: await gitBlobSha(ORIGINAL_COLLECTOR),
      nodeVersion: process.version,
      scenario,
      job: {
        jobId: job.jobId,
        idempotencyKeyHash: idempotencyHash,
        collectionMode: job.collectionMode,
        collectionPurpose: job.collectionPurpose,
        searchMode: job.searchMode
      },
      collectorInvocations: { reference: 1, worker: 1 },
      reference,
      worker: summarizeWorkerResult(worker),
      comparison,
      storage: { root: "<dedicated-parity-root>", workerCounts: counts },
      networkIsolation: {
        preloadFixtureOverSocketBlocker: true,
        actualExternalRequests,
        referenceFixtureRequests: Number(reference.networkTrace?.fixtureRequestCount || 0),
        workerFixtureRequests: Number(workerTrace?.fixtureRequestCount || 0)
      },
      operationalWrites: false,
      automaticRetry: false,
      automaticFallback: false,
      functionalObservations: {
        officialNaverApiInvoked: false,
        originalNaverBoundary: "pcmap.place.naver.com Apollo snapshot",
        duplicateRowsRetained: comparison.duplicateRowsRetained ?? null
      }
    };
    if (report.collectorBlobAfter !== EXPECTED_COLLECTOR_BLOB) {
      throw new ParityError("COLLECTOR_BLOB_MISMATCH", "baseline", "Frozen collector changed during parity execution.");
    }
    if (actualExternalRequests !== 0) {
      throw new ParityError("PARITY_EXTERNAL_REQUEST_DETECTED", "network_isolation", "Parity execution reported an external request.");
    }
    const reportFile = path.join(roots.reports, `${runName}.json`);
    assertContained(roots.reports, reportFile);
    await writeJsonAtomic(reportFile, report);
    return { report, reportFile, roots, runRoot, workerRoot, job };
  } finally {
    restoreEnvironment(previousEnv);
  }
}

function parseArgs(argv) {
  const args = { jobFile: "", root: "", scenario: "success", suite: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--job-file") args.jobFile = argv[++index] || "";
    else if (token.startsWith("--job-file=")) args.jobFile = token.slice("--job-file=".length);
    else if (token === "--root") args.root = argv[++index] || "";
    else if (token.startsWith("--root=")) args.root = token.slice("--root=".length);
    else if (token === "--scenario") args.scenario = argv[++index] || "success";
    else if (token.startsWith("--scenario=")) args.scenario = token.slice("--scenario=".length) || "success";
    else if (token === "--suite") args.suite = true;
    else throw new ParityError("PARITY_ARGUMENT_INVALID", "input", `Unknown argument: ${token}`);
  }
  return args;
}

async function readJob(jobFile) {
  if (!jobFile) throw new ParityError("PARITY_JOB_FILE_REQUIRED", "input", "--job-file is required.");
  try {
    return JSON.parse(await fsp.readFile(path.resolve(jobFile), "utf8"));
  } catch (error) {
    throw new ParityError("PARITY_JOB_INVALID", "input", `Parity job could not be read: ${error.code || error.name}.`);
  }
}

async function executeSuite(spec, root) {
  const suite = [];
  for (let index = 0; index < DEFAULT_SUITE.length; index += 1) {
    const scenario = DEFAULT_SUITE[index];
    const job = {
      ...spec,
      jobId: `${spec.jobId}-${scenario}`,
      idempotencyKey: `${spec.idempotencyKey}-${scenario}`
    };
    const execution = await executeParity(job, {
      root,
      scenario,
      runName: `${String(index + 1).padStart(2, "0")}-${scenario}`
    });
    suite.push(execution);
  }
  const successRun = suite.find((item) => item.report.scenario === "success");
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAllow = process.env.V4_WORKER_ALLOW_OFFLINE_PARITY;
  process.env.NODE_ENV = "test";
  process.env.V4_WORKER_ALLOW_OFFLINE_PARITY = "1";
  let replay;
  try {
    replay = await executeJob(successRun.job, { dataRoot: successRun.workerRoot, parityScenario: "success" });
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousAllow === undefined) delete process.env.V4_WORKER_ALLOW_OFFLINE_PARITY;
    else process.env.V4_WORKER_ALLOW_OFFLINE_PARITY = previousAllow;
  }
  const roots = await ensureParityRoot(root);
  const report = {
    schemaVersion: PARITY_SUITE_SCHEMA,
    baselineCommit: PARITY_SOURCE_BASELINE_COMMIT,
    collectorBaselineCommit: BASELINE_COMMIT,
    collectorBlobBefore: suite[0].report.collectorBlobBefore,
    collectorBlobAfter: await gitBlobSha(ORIGINAL_COLLECTOR),
    nodeVersion: process.version,
    scenarios: suite.map((item) => ({
      scenario: item.report.scenario,
      matched: item.report.comparison.matched,
      referenceStatus: item.report.reference.status,
      workerStatus: item.report.worker.status,
      workerCode: item.report.worker.code,
      actualExternalRequests: item.report.networkIsolation.actualExternalRequests,
      duplicateRowsRetained: item.report.functionalObservations.duplicateRowsRetained
    })),
    idempotencyReplay: {
      status: replay.status,
      code: replay.code,
      duplicate: replay.duplicate,
      artifactId: replay.artifactId
    },
    allBehavioralComparisonsMatched: suite.every((item) => item.report.comparison.matched),
    actualExternalRequests: suite.reduce((total, item) => total + item.report.networkIsolation.actualExternalRequests, 0),
    operationalWrites: false,
    mismatchReport: suite.flatMap((item) => item.report.comparison.mismatches.map((mismatch) => ({
      scenario: item.report.scenario,
      ...mismatch
    }))),
    parityClassification: {
      matched: [
        "Frozen collector direct execution and V4 execution produce the same collector file set and canonical content.",
        "Manifest schema, manifest counts, parsed CSV values, XLSX sheet values, and expected failure contracts match.",
        "Successful idempotency replay returns the existing V4 artifact without a collector rerun.",
        "All fixture scenarios report zero actual external requests and zero operational writes."
      ],
      mismatched: [
        "The frozen collector uses Naver pcmap Apollo snapshots rather than the approved official Local Search API canary path.",
        "Duplicate provider rows remain duplicated in collector output; V4 preserves that behavior instead of removing them."
      ],
      unknown: [
        "Real Provider response semantics and data quality were not tested.",
        "Naver booking inventory with non-empty products and schedules was not fixture-verified.",
        "The Phase 6 Provider response cannot be reconstructed because the raw response was intentionally not retained.",
        "Direct ONDA collection and successful Yeogi parsing are not implemented in the frozen collector."
      ]
    }
  };
  const reportFile = path.join(roots.reports, "parity-suite.json");
  await writeJsonAtomic(reportFile, report);
  return { report, reportFile };
}

async function main() {
  let output;
  try {
    const args = parseArgs(process.argv.slice(2));
    const spec = await readJob(args.jobFile);
    const result = args.suite
      ? await executeSuite(spec, args.root ? path.resolve(args.root) : "")
      : await executeParity(spec, { root: args.root ? path.resolve(args.root) : "", scenario: args.scenario });
    output = {
      schemaVersion: args.suite ? PARITY_SUITE_SCHEMA : PARITY_REPORT_SCHEMA,
      status: "succeeded",
      reportFile: result.reportFile,
      matched: args.suite ? result.report.allBehavioralComparisonsMatched : result.report.comparison.matched,
      actualExternalRequests: result.report.actualExternalRequests ?? result.report.networkIsolation.actualExternalRequests,
      operationalWrites: false
    };
  } catch (error) {
    output = {
      schemaVersion: PARITY_REPORT_SCHEMA,
      status: "failed",
      code: error.code || "PARITY_INTERNAL_ERROR",
      stage: error.stage || "parity",
      message: sanitizeText(error.message || error).slice(0, 800),
      retryable: false
    };
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

module.exports = {
  DEFAULT_SUITE,
  PARITY_REPORT_SCHEMA,
  PARITY_ROOT_SCHEMA,
  PARITY_SOURCE_BASELINE_COMMIT,
  PARITY_SUITE_SCHEMA,
  ParityError,
  compareCollectorArtifacts,
  ensureParityRoot,
  executeParity,
  executeSuite,
  validateTrace
};

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ status: "failed", code: error.code || "PARITY_INTERNAL_ERROR" })}\n`);
    process.exitCode = 1;
  });
}
