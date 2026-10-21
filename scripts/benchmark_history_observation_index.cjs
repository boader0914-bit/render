"use strict";

// Synthetic, local-only growth evidence. No production data, network or service
// configuration is used. Each volume runs in its own child process so retained
// allocations from a smaller fixture cannot influence a larger fixture.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { createHistoryObservationIndex } = require("./lib/history_observation_index.cjs");
const TARGET = "synthetic_target", MONTH = "2026-09", TARGET_ROWS = 100, APPEND_ROWS = 40;
const memory = () => {
  const value = process.memoryUsage();
  return { rssBytes: value.rss, heapUsedBytes: value.heapUsed, externalBytes: value.external, arrayBuffersBytes: value.arrayBuffers };
};
const delta = (before, after) => Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - (before[key] || 0)]));
const roundMs = value => Math.round(value * 1000) / 1000;
function generatedRow(index, { appended = false } = {}) {
  const selected = appended ? index < 10 || index >= 20 : index < TARGET_ROWS;
  const month = appended && index >= 20 ? "2026-10" : MONTH;
  return { observationId: `${appended ? "append" : "seed"}_${index}`, companyKey: selected ? TARGET : `synthetic_other_${index % 1000}`,
    companyId: selected ? TARGET : `synthetic_other_${index % 1000}`, runId: `${appended ? "delta" : "seed"}_run_${index % 13}`,
    keyword: appended ? "synthetic_new_keyword" : `synthetic_keyword_${index % 13}`,
    stayDate: `${month}-${String(index % 28 + 1).padStart(2, "0")}`, collectedAt: "2026-09-01T00:00:00.000Z", productType: "lodging",
    supply: 16, sold: index % 7, publicBookings: index % 7, publicRevenue: index % 7 * 100000,
    inventoryEvidenceVersion: 4, partial: false, missing: false, synthetic: true };
}
async function fileHash(file, limit = Infinity) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of native.createReadStream(file, Number.isFinite(limit) ? { end: limit - 1 } : {})) { hash.update(chunk); bytes += chunk.length; }
  return { digest: hash.copy().digest("hex"), bytes, hash };
}
async function writeFixture(file, rows) {
  const handle = await fs.open(file, "wx", 0o600), hash = crypto.createHash("sha256");
  let buffer = "", bytes = 0;
  try {
    for (let index = 0; index < rows; index++) {
      buffer += JSON.stringify(generatedRow(index)) + "\n";
      if (Buffer.byteLength(buffer) >= 64 * 1024 || index === rows - 1) {
        const block = Buffer.from(buffer); await handle.writeFile(block); hash.update(block); bytes += block.length; buffer = "";
      }
    }
    await handle.sync();
  } finally { await handle.close(); }
  return { bytes, digest: hash.digest("hex") };
}
async function child(rows) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-index-growth-"));
  const file = path.join(root, "observations.jsonl"), indexFile = path.join(root, "observations.sqlite"), phases = {};
  let index = null, sampledPeak = memory(), sampleCount = 0;
  const sample = () => { const value = memory(); sampleCount++; for (const key of Object.keys(value)) sampledPeak[key] = Math.max(sampledPeak[key], value[key]); return value; };
  const timer = setInterval(sample, 10); timer.unref();
  const measure = async (name, operation) => {
    const beforeStats = index.stats(), beforeMemory = sample(), start = performance.now();
    const value = await operation(); const elapsedMs = roundMs(performance.now() - start), afterMemory = sample();
    phases[name] = { elapsedMs, indexStatsDelta: delta(beforeStats, index.stats()), beforeMemory, afterMemory };
    return value;
  };
  try {
    const original = await writeFixture(file, rows); sample();
    index = createHistoryObservationIndex({ file, indexFile });
    const initial = await measure("initialIndex", () => index.ensure());
    if (initial.rows !== rows || initial.mode !== "rebuilt") throw new Error("Synthetic initial index mismatch");
    phases.initialIndex.indexFileBytes = (await fs.stat(indexFile)).size;
    const beforeAppendIndexBytes = phases.initialIndex.indexFileBytes;
    await index.close(); index = createHistoryObservationIndex({ file, indexFile });
    const restarted = await measure("unchangedRestart", () => index.ensure());
    if (restarted.mode !== "unchanged" || phases.unchangedRestart.indexStatsDelta.bytesReadOriginal !== 0) throw new Error("Unchanged restart read original bodies");
    let selectedRows = 0, selectedSold = 0;
    await measure("fixedCompanyMonthQuery", () => index.readRows({ month: MONTH, refs: [TARGET] }, row => { selectedRows++; selectedSold += row.sold; }));
    if (selectedRows !== TARGET_ROWS) throw new Error("Synthetic selected row mismatch");
    Object.assign(phases.fixedCompanyMonthQuery, { selectedRows, selectedSold });
    let selectedHeaders = 0;
    await measure("fixedCompanyMonthHeaders", () => index.readHeaders({ month: MONTH, refs: [TARGET] }, () => { selectedHeaders++; }));
    if (selectedHeaders !== TARGET_ROWS) throw new Error("Synthetic selected header mismatch");
    phases.fixedCompanyMonthHeaders.selectedHeaders = selectedHeaders;
    const readOnlyHash = await fileHash(file);
    if (readOnlyHash.digest !== original.digest || readOnlyHash.bytes !== original.bytes) throw new Error("Index or query modified authoritative source");
    const appendedRows = Array.from({ length: APPEND_ROWS }, (_, index) => generatedRow(index, { appended: true }));
    const payload = Buffer.from(appendedRows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const expectedAfterHash = readOnlyHash.hash.copy().update(payload).digest("hex");
    const append = await measure("fixedAppend", () => index.append(payload));
    if (!append.indexed || append.appendedBytes !== payload.length || phases.fixedAppend.indexStatsDelta.rebuilt !== 0
      || phases.fixedAppend.indexStatsDelta.incremental !== 1 || phases.fixedAppend.indexStatsDelta.bytesReadOriginal !== payload.length) throw new Error("Synthetic fixed append was not an append-only index update");
    Object.assign(phases.fixedAppend, { appendedRows: APPEND_ROWS, appendedBytes: payload.length });
    selectedRows = 0; selectedSold = 0;
    const afterQuery = await measure("fixedCompanyMonthQueryAfterAppend", () => index.readRows({ month: MONTH, refs: [TARGET] }, row => { selectedRows++; selectedSold += row.sold; }));
    if (selectedRows !== TARGET_ROWS + 10 || afterQuery.rows !== rows + APPEND_ROWS) throw new Error("Synthetic append selection mismatch");
    Object.assign(phases.fixedCompanyMonthQueryAfterAppend, { selectedRows, selectedSold });
    const lookup = await measure("fixedAppendIdLookup", () => index.findObservationIds({ observationIds: appendedRows.map(row => row.observationId) }));
    if (lookup.existingIds.size !== APPEND_ROWS) throw new Error("Synthetic append ID presence mismatch");
    phases.fixedAppendIdLookup.matchedIds = lookup.existingIds.size;
    for (const name of ["fixedCompanyMonthQuery", "fixedCompanyMonthHeaders", "fixedCompanyMonthQueryAfterAppend", "fixedAppendIdLookup"])
      if (phases[name].indexStatsDelta.bytesReadOriginal !== 0) throw new Error("Indexed query reopened original bodies");
    const actualAfter = await fileHash(file), originalPrefixAfter = await fileHash(file, original.bytes), afterIndexBytes = (await fs.stat(indexFile)).size;
    if (actualAfter.digest !== expectedAfterHash || originalPrefixAfter.digest !== original.digest || actualAfter.bytes !== original.bytes + payload.length) throw new Error("Source append preservation mismatch");
    return { synthetic: true, originalRows: rows, originalBytes: original.bytes, fixedTargetRows: TARGET_ROWS, fixedAppendRows: APPEND_ROWS,
      phases, sqlite: { beforeAppendBytes: beforeAppendIndexBytes, afterAppendBytes: afterIndexBytes, growthBytes: afterIndexBytes - beforeAppendIndexBytes },
      memory: { sampledPeakBytes: sampledPeak, samples: sampleCount, lifetimeMaxRssKiB: process.resourceUsage().maxRSS,
        note: "10ms timer plus phase-boundary samples; synchronous SQLite and GC pauses can hide peaks. maxRSS is this isolated child process lifetime, including fixture generation. No forced GC." },
      verification: { originalSha256: original.digest, originalPrefixSha256AfterAppend: originalPrefixAfter.digest,
        expectedAfterSha256: expectedAfterHash, actualAfterSha256: actualAfter.digest, originalUnchangedDuringReadStages: true,
        sourceChangedOnlyByExpectedAppend: true, independentHashReadsExcludedFromIndexByteCounters: true } };
  } finally {
    clearInterval(timer); if (index) await index.close();
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("history-index-growth-")) throw new Error("Refusing unexpected benchmark cleanup target");
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
function parse(args) {
  const options = { volumes: [5000, 50000, 150000], output: null, child: null };
  for (let index = 0; index < args.length; index++) {
    const key = args[index], value = args[++index];
    if (key === "--output" && value) options.output = path.resolve(value);
    else if (key === "--volumes" && value) options.volumes = value.split(",").map(Number);
    else if (key === "--child" && value) options.child = Number(value);
    else throw new Error("Usage: node scripts/benchmark_history_observation_index.cjs [--volumes 5000,50000,150000] [--output new-file.json]");
  }
  const sizes = options.child === null ? options.volumes : [options.child];
  if (!sizes.length || sizes.length > 8 || sizes.some(value => !Number.isSafeInteger(value) || value < TARGET_ROWS || value > 1000000)) throw new Error("Use one to eight synthetic volumes between 100 and 1000000 rows");
  return options;
}
async function main() {
  const options = parse(process.argv.slice(2));
  if (options.child !== null) { process.stdout.write(JSON.stringify(await child(options.child))); return; }
  const results = [];
  for (const rows of options.volumes) {
    const run = spawnSync(process.execPath, [__filename, "--child", String(rows)], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (run.error || run.status !== 0) throw new Error(`Synthetic ${rows}-row benchmark failed: ${run.error?.message || run.stderr || run.stdout}`);
    results.push(JSON.parse(run.stdout));
  }
  const result = { schemaVersion: 1, generatedAt: new Date().toISOString(), evidenceType: "synthetic_local_growth_benchmark",
    source: "Generated public-like observation rows; no actual collection or production data", productionClaims: false,
    implementationSha256: crypto.createHash("sha256").update(native.readFileSync(require.resolve("./lib/history_observation_index.cjs"))).digest("hex"),
    nodeVersion: process.version, platform: process.platform, independentProcessPerVolume: true, networkRequests: 0,
    limitations: ["One local run per volume; not a latency SLA or a production memory ceiling", "SQLite quick_check on reopening may scale with the derived index even when original bytes read are zero", "Independent SHA verification reads source bytes outside the timed index operations and their byte counters"], results };
  const encoded = JSON.stringify(result, null, 2) + "\n";
  if (options.output) { await fs.mkdir(path.dirname(options.output), { recursive: true }); await fs.writeFile(options.output, encoded, { flag: "wx", mode: 0o600 }); }
  process.stdout.write(encoded);
}
if (require.main === module) main().catch(error => { process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; });
