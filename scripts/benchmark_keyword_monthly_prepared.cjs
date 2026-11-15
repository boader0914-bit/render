"use strict";

// Local-only synthetic verifier. This script never opens an application data
// directory, imports the app server, calls a provider, forces GC, or removes a
// directory. Its new fixture namespace is retained for independent inspection.
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), v8 = require("node:v8");
const { performance } = require("node:perf_hooks");
const { buildKeywordMonthlyProjection } = require("./lib/keyword_monthly_analysis.cjs");
const { createKeywordMonthlyBundleAnalysis, publishKeywordMonthlyBundle, loadBundle } = require("./lib/keyword_monthly_bundle.cjs");
const { keywordMonthlyAllocationCheckpoint } = require("./lib/keyword_monthly_memory_admission.cjs");

const ITERATIONS = 30, NOW = "2026-11-15T03:00:00.000Z", KEYWORD = "가상 성능검수 글램핑";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fault = code => Object.assign(new Error(code), { code });
function need(value, code) { if (!value) throw fault(code); }
const safeCode = error => /^[A-Z][A-Z0-9_]{1,99}$/.test(error?.code || "") ? error.code : "SYNTHETIC_BENCHMARK_FAILED";
function argumentsFor(values) {
  if (values.length === 1 && values[0] === "--help") return { help: true };
  need(values.length === 2 && values[0] === "--output" && typeof values[1] === "string" && path.isAbsolute(values[1])
    && path.resolve(values[1]) !== path.parse(path.resolve(values[1])).root && path.extname(values[1]) === ".json", "SYNTHETIC_BENCHMARK_ARGUMENTS");
  return { output: path.resolve(values[1]) };
}
function networkGuard() {
  let attempts = 0; const restores = [];
  const block = (object, key) => { const original = object[key]; if (typeof original !== "function") return;
    object[key] = () => { attempts++; throw fault("SYNTHETIC_BENCHMARK_NETWORK_BLOCKED"); }; restores.push(() => { object[key] = original; }); };
  block(globalThis, "fetch"); block(globalThis, "WebSocket");
  for (const name of ["node:http", "node:https"]) for (const key of ["get", "request"]) block(require(name), key);
  for (const key of ["connect", "createConnection"]) block(require("node:net"), key);
  block(require("node:net").Socket.prototype, "connect"); block(require("node:tls"), "connect");
  for (const key of ["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"]) block(require("node:child_process"), key);
  return { count: () => attempts, restore: () => { for (const restore of restores.reverse()) restore(); } };
}
function syntheticSource() {
  const companies = Array.from({ length: 20 }, (_, index) => ({ companyId: `synthetic_cmp_${String(index + 1).padStart(3, "0")}`,
    primaryName: `가상 검수 숙소 ${String(index + 1).padStart(2, "0")}`, regionKey: "synthetic_region", regionLabel: "가상 검수 지역",
    capacity: 8 + index % 13, capacitySource: "db_correction" }));
  const runs = [], observations = [], rankObservations = [];
  for (const month of ["2026-10", "2026-11"]) {
    const [year, part] = month.split("-").map(Number), days = new Date(Date.UTC(year, part, 0)).getUTCDate();
    for (let day = 1; day <= days; day++) {
      const stayDate = `${month}-${String(day).padStart(2, "0")}`, stayTime = Date.parse(`${stayDate}T00:00:00.000Z`);
      const observedDay = Math.min(stayTime - 2 * 86400000, Date.parse("2026-11-13T00:00:00.000Z"));
      const weekend = [5, 6].includes(new Date(stayTime).getUTCDay());
      for (let repeat = 0; repeat < 6; repeat++) {
        const id = `synthetic_${month.replace("-", "")}_${String(day).padStart(2, "0")}_${repeat}`;
        const collectedAt = new Date(observedDay + 3600000 + repeat * 20 * 60000).toISOString();
        runs.push({ id, keyword: KEYWORD, collectedAt, collectionQuality: { status: "complete" } });
        for (let index = 0; index < companies.length; index++) {
          const company = companies[index], supply = company.capacity;
          const publicBookings = Math.min(supply, Math.floor(supply * (0.1 + repeat * 0.055 + index % 5 * 0.02)));
          const phoneBookings = Math.min(supply - publicBookings, (index + repeat) % 3), sold = publicBookings + phoneBookings;
          const price = (weekend ? 130000 : 90000) + index * 2500;
          const priceUnknown = index === 2 && day === 16;
          const row = { observationId: `${id}:${company.companyId}:lodging`, companyId: company.companyId, runId: id, keyword: KEYWORD,
            productType: "lodging", stayDate, collectedAt, inventoryEvidenceVersion: 4, supply, sold, publicBookings, phoneBookings,
            publicRevenue: priceUnknown ? null : publicBookings * price, phoneRevenue: priceUnknown ? null : phoneBookings * price,
            estimatedRevenue: priceUnknown ? null : sold * price, sharedDayUseExcluded: 0, explicitBlockedBookings: Math.min(phoneBookings, 1),
            phoneMissingPriceBookings: priceUnknown ? phoneBookings : 0, partial: false, missing: false, unknownUnavailable: 0,
            dayUsePresence: index % 4 === 0 ? "present" : "absent", dayUseSharingStatus: "not_shared",
            capacityBasis: { count: supply, source: "db_correction" } };
          observations.push(row);
          if (index % 4 === 0 && repeat % 2 === 0) {
            const quantity = (index + repeat + day) % 4;
            observations.push({ ...row, observationId: `${id}:${company.companyId}:dayuse`, productType: "dayuse", supply: 3,
              sold: quantity, publicBookings: quantity, phoneBookings: 0, explicitBlockedBookings: 0,
              publicRevenue: quantity * 35000, phoneRevenue: 0, estimatedRevenue: quantity * 35000,
              phoneMissingPriceBookings: 0, dayUsePresence: "present", capacityBasis: { count: 3, source: "observed_max" } });
          }
          if (day === 3 && repeat === 0) rankObservations.push({ companyId: company.companyId, runId: id, keyword: KEYWORD, rank: index + 1, collectedAt });
        }
      }
    }
  }
  need(companies.length === 20 && observations.length >= 6000 && observations.length <= 10000
    && observations.every(row => row.collectedAt <= NOW && row.collectedAt.slice(0, 10) <= row.stayDate), "SYNTHETIC_BENCHMARK_FIXTURE_INVALID");
  return { companies, runs, observations, rankObservations, savedProductRecoveries: [],
    warnings: ["가상 성능검수 자료입니다. 실제 숙소·고객·매출을 포함하지 않습니다."],
    sourceDiagnostics: { runInventoryComplete: 1, intermediateObservationsComplete: 1 } };
}
function semantic(result) {
  return { status: result.status, request: result.request, snapshot: result.snapshot, activity: result.activity,
    latestAttempt: result.latestAttempt, lastSuccessfulAttempt: result.lastSuccessfulAttempt, diagnostics: result.diagnostics };
}
function semanticDigest(result) { return hash(JSON.stringify(semantic(result))); }
function statistics(samples, failures) {
  const values = samples.filter(row => row.ok).map(row => row.readMs).sort((a, b) => a - b), quantile = p => values.length ? values[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
  return { attempts: samples.length, successful: values.length, failures, medianMs: values.length ? (values[(values.length - 1) >> 1] + values[values.length >> 1]) / 2 : null,
    p95Ms: quantile(0.95), maxMs: values.at(-1) ?? null, samples };
}
async function tree(directory) {
  const files = [];
  async function visit(relative) {
    const current = path.join(directory, relative), entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = path.join(relative, entry.name), file = path.join(directory, child), stat = await fs.lstat(file);
      need(!stat.isSymbolicLink(), "SYNTHETIC_BENCHMARK_UNSAFE_FIXTURE");
      if (entry.isDirectory()) await visit(child);
      else { need(entry.isFile() && stat.nlink === 1, "SYNTHETIC_BENCHMARK_UNSAFE_FIXTURE");
        const bytes = await fs.readFile(file); files.push({ path: child.split(path.sep).join("/"), bytes: bytes.length, sha256: hash(bytes), mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino }); }
    }
  }
  await visit(""); return { fileCount: files.length, totalBytes: files.reduce((sum, row) => sum + row.bytes, 0), files,
    contentDigest: hash(JSON.stringify(files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })))), metadataDigest: hash(JSON.stringify(files)) };
}
function memoryCheckpoint(label, records) {
  const usage = process.memoryUsage(), sample = { label, at: new Date().toISOString(), heapUsed: usage.heapUsed, heapTotal: usage.heapTotal,
    rss: usage.rss, external: usage.external, arrayBuffers: usage.arrayBuffers, heapSizeLimit: v8.getHeapStatistics().heap_size_limit };
  records.push(sample); return sample;
}
async function run(output) {
  const startedAt = new Date().toISOString(), report = { schemaVersion: 1, kind: "synthetic_keyword_prepared_benchmark", status: "running", syntheticOnly: true,
    fixedClock: NOW, iterationsPerPath: ITERATIONS, nodeVersion: process.versions.node, platform: process.platform, startedAt,
    conditions: "Sequential local file reads; no HTTP, network, queue load, app server, forced GC or production data.",
    timingDefinition: "readMs covers the awaited runtime reader only; validateMs additionally includes deterministic logical serialization and digest validation. No priming runtime query is excluded.",
    memoryInterpretation: "Highest endpoint/checkpoint observation, not a continuous allocation peak. arrayBuffers is already part of external; do not sum them.",
    memory: [], paths: {}, failures: [], providerCalls: 0, productionChanges: false, cleanupPerformed: false };
  await fs.mkdir(path.dirname(output), { recursive: true });
  const out = await fs.open(output, "wx", 0o600), guard = networkGuard(); let failure;
  try {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-prepared-benchmark-"));
    need(path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith("keyword-prepared-benchmark-"), "SYNTHETIC_BENCHMARK_NAMESPACE_INVALID");
    report.temporaryArtifactRoot = root; memoryCheckpoint("before_fixture", report.memory);
    const source = syntheticSource(), bytes = Buffer.from(JSON.stringify(source)), inputFile = path.join(root, "synthetic-source.json");
    await fs.writeFile(inputFile, bytes, { flag: "wx", mode: 0o600 });
    report.fixture = { companyCount: source.companies.length, observationCount: source.observations.length, rankObservationCount: source.rankObservations.length,
      runCount: source.runs.length, reportMonths: ["2026-10", "2026-11"], sourceBytes: bytes.length, sourceSha256: hash(bytes) };
    const projection = path.join(root, "projection"), legacyDir = path.join(root, "legacy-bundle"), preparedDir = path.join(root, "prepared-bundle");
    await buildKeywordMonthlyProjection({ source, sourceFingerprint: hash(bytes), outputDir: projection, materializedAt: NOW, now: () => NOW, compression: "gzip" });
    await publishKeywordMonthlyBundle({ inputs: [{ directory: projection }], outputDir: legacyDir, now: NOW });
    const publication = await publishKeywordMonthlyBundle({ inputs: [{ directory: projection }], outputDir: preparedDir, now: NOW, prepareResults: true });
    memoryCheckpoint("after_explicit_preparation", report.memory);
    report.preparation = { preparedResultCount: publication.preparedResultCount, calculationFingerprint: publication.calculationFingerprint, totalStoredBytes: publication.totalStoredBytes };
    const before = await tree(root); report.preservation = { before };
    const phases = { legacy: {}, prepared: {} };
    const make = (directory, lane) => createKeywordMonthlyBundleAnalysis({ projectionDir: directory, now: () => NOW,
      measure: async (phase, _metadata, operation) => { await keywordMonthlyAllocationCheckpoint(phase); phases[lane][phase] = (phases[lane][phase] || 0) + 1; return operation(); } });
    const legacy = make(legacyDir, "legacy"), prepared = make(preparedDir, "prepared"), options = await legacy.options();
    const keyword = options.keywords.find(row => row.keyword === KEYWORD), query = { keyword: KEYWORD, month: "2026-11", cutoffDate: keyword.defaultCutoffs["2026-11"] };
    report.query = query; let expectedDigest = null;
    for (const [lane, service] of [["legacy", legacy], ["prepared", prepared]]) {
      const samples = []; let failures = 0;
      for (let index = 0; index < ITERATIONS; index++) {
        memoryCheckpoint(`${lane}_${index + 1}_before`, report.memory); const at = performance.now();
        try {
          let result = await service.analyze(query); const readMs = performance.now() - at;
          memoryCheckpoint(`${lane}_${index + 1}_read`, report.memory);
          need(["available", "stale"].includes(result.status) && result.snapshot && result.snapshot.quality.companyCount === 20, "SYNTHETIC_BENCHMARK_RESULT_UNAVAILABLE");
          if (lane === "prepared") need(result.preparedResult?.status === "ready", "SYNTHETIC_BENCHMARK_PREPARED_FALLBACK");
          const digest = semanticDigest(result); if (expectedDigest === null) expectedDigest = digest;
          need(digest === expectedDigest, "SYNTHETIC_BENCHMARK_LOGICAL_MISMATCH");
          const payloadBytes = Buffer.byteLength(JSON.stringify(result));
          if (!report.logicalResult) report.logicalResult = { digest, generatedAt: result.snapshot.generatedAt, request: result.request,
            lodging: result.snapshot.summary.lodging, dayuse: result.snapshot.summary.dayuse, quality: result.snapshot.quality.status };
          samples.push({ iteration: index + 1, ok: true, readMs, validateMs: performance.now() - at, payloadBytes });
          result = null; memoryCheckpoint(`${lane}_${index + 1}_validated`, report.memory);
        } catch (error) { failures++; samples.push({ iteration: index + 1, ok: false, elapsedMs: performance.now() - at, code: safeCode(error) }); report.failures.push({ lane, iteration: index + 1, code: safeCode(error) }); }
      }
      report.paths[lane] = statistics(samples, failures);
      console.log(JSON.stringify({ synthetic: true, path: lane, attempts: samples.length, failures, medianMs: report.paths[lane].medianMs, p95Ms: report.paths[lane].p95Ms, maxMs: report.paths[lane].maxMs }));
    }
    report.phases = phases;
    need(ITERATIONS === 30 && Object.values(report.paths).every(row => row.attempts === 30 && row.successful === 30 && row.failures === 0), "SYNTHETIC_BENCHMARK_INCOMPLETE");
    need((phases.legacy.keyword_snapshot_current || 0) === 30 && (phases.legacy.keyword_snapshot_previous || 0) === 30
      && !(phases.prepared.keyword_snapshot_current || phases.prepared.keyword_snapshot_previous || phases.prepared.keyword_projection_read || phases.prepared.keyword_source_validate)
      && phases.prepared.keyword_prepared_result_read === 30, "SYNTHETIC_BENCHMARK_RECONSTRUCTION_NOT_REMOVED");
    const after = await tree(root); report.preservation.after = after;
    report.preservation.unchanged = before.contentDigest === after.contentDigest && before.metadataDigest === after.metadataDigest;
    need(report.preservation.unchanged, "SYNTHETIC_BENCHMARK_ARTIFACT_CHANGED");
    const preparedBundle = await loadBundle(preparedDir), resultDescriptor = preparedBundle.catalog.preparedResults.find(row => row.keyword === query.keyword && row.month === query.month && row.cutoffDate === query.cutoffDate);
    report.byteSizes = { source: bytes.length, projectionFiles: before.files.filter(row => row.path.startsWith("projection/projections/")).map(row => ({ path: row.path, bytes: row.bytes })),
      preparedFile: resultDescriptor.bytes, preparedDecodedFile: resultDescriptor.uncompressedBytes || resultDescriptor.bytes,
      legacyResponse: report.paths.legacy.samples[0].payloadBytes, preparedResponse: report.paths.prepared.samples[0].payloadBytes };
    report.originalAndPointers = { source: before.files.find(row => row.path === "synthetic-source.json").sha256,
      legacyPointer: before.files.find(row => row.path === "legacy-bundle/current.json").sha256, preparedPointer: before.files.find(row => row.path === "prepared-bundle/current.json").sha256,
      projectionIndex: before.files.find(row => row.path === "projection/index.json").sha256, unchanged: report.preservation.unchanged };
    report.endpointMemoryMax = Object.fromEntries(["heapUsed", "heapTotal", "rss", "external", "arrayBuffers"].map(key => [key, Math.max(...report.memory.map(row => row[key]))]));
    report.providerCalls = guard.count(); need(report.providerCalls === 0, "SYNTHETIC_BENCHMARK_NETWORK_ATTEMPTED"); report.status = "passed";
  } catch (error) { failure = error; report.status = "failed"; report.errorCode = safeCode(error); }
  finally {
    report.providerCalls = guard.count(); report.finishedAt = new Date().toISOString(); guard.restore();
    try { await out.writeFile(JSON.stringify(report, null, 2) + "\n"); await out.sync(); } finally { await out.close(); }
  }
  console.log(JSON.stringify({ status: report.status, syntheticOnly: true, output, failureCount: report.failures.length, providerCalls: report.providerCalls, originalAndPointers: report.originalAndPointers }));
  if (failure) throw failure; return report;
}
if (require.main === module) {
  Promise.resolve().then(() => argumentsFor(process.argv.slice(2))).then(options => options.help ? console.log("node scripts/benchmark_keyword_monthly_prepared.cjs --output <absolute new JSON file>") : run(options.output))
    .catch(error => { console.error(JSON.stringify({ code: safeCode(error), syntheticOnly: true })); process.exitCode = 1; });
}
module.exports = { argumentsFor, syntheticSource, semantic, statistics, run };
