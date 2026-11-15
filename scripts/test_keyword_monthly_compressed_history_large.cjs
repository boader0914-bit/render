"use strict";
// Explicit disposable stress proof, not normal CI and not a business-row fixture.
const fs = require("node:fs/promises"), native = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), zlib = require("node:zlib"), assert = require("node:assert/strict");
const { pipeline } = require("node:stream/promises"), { spawnSync } = require("node:child_process"), C = require("./lib/keyword_monthly_source_copy.cjs");
async function hashFile(file) {
  const digest = crypto.createHash("sha256"); let bytes = 0;
  for await (const chunk of native.createReadStream(file, { highWaterMark: 1024 * 1024 })) { digest.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: digest.digest("hex") };
}
async function stress() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-compressed-large-")), started = Date.now(); let timer, peakRss = 0, peakHeap = 0, report;
  const measure = () => { const value = process.memoryUsage(); peakRss = Math.max(peakRss, value.rss); peakHeap = Math.max(peakHeap, value.heapUsed); };
  try {
    timer = setInterval(measure, 10); measure();
    const source = path.join(root, "source");
    for (const directory of ["company_master", "history", "outputs"]) await fs.mkdir(path.join(source, directory), { recursive: true });
    // Sparse zero bodies exercise byte-exact copying/compression only. Parsing
    // and normalized numeric parity are tested separately with real saved copies.
    for (const [relative, bytes] of [["company_master/companies.json", 120 * 1024 ** 2], ["history/observations.jsonl", 450 * 1024 ** 2]]) {
      const handle = await fs.open(path.join(source, ...relative.split("/")), "wx", 0o600); try { await handle.truncate(bytes); } finally { await handle.close(); }
    }
    const files = ["company_master/companies.json", "history/observations.jsonl"], before = {};
    for (const relative of files) before[relative] = await hashFile(path.join(source, ...relative.split("/")));
    const raw = await C.inspect({ sourceDataDir: source, scratchParent: root });
    assert.equal(raw.copyBytes, 570 * 1024 ** 2); assert.equal(raw.canCopyWithReserve, false);
    const rawRoot = path.join(root, "keyword-monthly-source-rawstress123");
    await assert.rejects(C.copy({ sourceDataDir: source, scratchParent: root, inspection: raw, copyRoot: rawRoot }), { code: "KEYWORD_COPY_CORE_WORKING_SET_BOUND" });
    await assert.rejects(fs.stat(rawRoot), { code: "ENOENT" });
    const inspection = await C.inspect({ sourceDataDir: source, scratchParent: root, historyCompression: "gzip" }); assert.equal(inspection.canCopyWithReserve, true);
    const copyRoot = path.join(root, "keyword-monthly-source-gzipstress123"), result = await C.copy({ sourceDataDir: source, scratchParent: root, historyCompression: "gzip", inspection, copyRoot });
    const capture = JSON.parse(await fs.readFile(path.join(copyRoot, "control/capture-complete.json"))), history = capture.inputFiles.find(row => row.compression === "gzip"), stored = path.join(capture.dataDir, ...history.storageRelative.split("/"));
    const storedIndependent = await hashFile(stored); assert.equal(storedIndependent.bytes, history.bytes); assert.equal(storedIndependent.sha256, history.sha256);
    const expandedHash = crypto.createHash("sha256"); let expandedBytes = 0;
    await pipeline(native.createReadStream(stored, { highWaterMark: 64 * 1024 }), zlib.createGunzip({ chunkSize: 64 * 1024 }), async chunks => { for await (const chunk of chunks) { expandedBytes += chunk.length; assert.ok(expandedBytes <= 512 * 1024 ** 2); expandedHash.update(chunk); } });
    assert.equal(expandedBytes, before["history/observations.jsonl"].bytes); const expandedSha256 = expandedHash.digest("hex");
    assert.equal(expandedSha256, before["history/observations.jsonl"].sha256); assert.equal(history.sourceSha256, expandedSha256);
    const after = {};
    for (const relative of files) { after[relative] = await hashFile(path.join(source, ...relative.split("/"))); assert.deepEqual(after[relative], before[relative]); }
    const company = capture.inputFiles.find(row => row.relative === "company_master/companies.json"), companyCopy = await hashFile(path.join(capture.dataDir, ...company.relative.split("/"))); assert.deepEqual(companyCopy, before[company.relative]);
    assert.equal(result.bytes, capture.inputFiles.reduce((sum, row) => sum + row.bytes, 0)); assert.ok(result.bytes <= 512 * 1024 ** 2); assert.ok(capture.scratch.peakReservedAndAllocatedBytes <= 1024 ** 3);
    measure();
    report = { status: "passed", fixtureKind: "disposable_sparse_zero_bytes_not_business_rows", childHeapLimitMiB: 256, rawCopyRejected: true, gzipCopyAccepted: true,
      sourceBytes: raw.copyBytes, physicalCopyBytes: result.bytes, physicalCopyLimitBytes: C.CORE_COPY_MAX_BYTES, scratchHardLimitBytes: C.OWN_SCRATCH_HARD_BYTES,
      sourceBefore: before, sourceAfter: after, storedHistory: storedIndependent, expandedHistory: { bytes: expandedBytes, sha256: expandedSha256 }, companyCopy,
      scratch: capture.scratch, memory: { peakRssSampledBytes: peakRss, peakHeapUsedSampledBytes: peakHeap, resourceUsageMaxRssKiB: process.resourceUsage().maxRSS },
      originalOutputBodiesCopied: result.originalOutputBodiesCopied, sourceWrites: result.sourceWrites, elapsedMs: Date.now() - started };
  } finally {
    clearInterval(timer);
    // Exact disposable fixture only. No caller-controlled path is removed.
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("keyword-compressed-large-"));
    async function writable(directory) { for (const entry of await fs.readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await writable(file); else await fs.chmod(file, 0o600); } }
    await writable(root); await fs.rm(root, { recursive: true, force: true });
  }
  return { ...report, disposableFixtureRemoved: true };
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--run-large-gzip") {
    const child = spawnSync(process.execPath, ["--max-old-space-size=256", __filename, "--large-child"], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120000 });
    if (child.stdout) process.stdout.write(child.stdout); if (child.stderr) process.stderr.write(child.stderr); if (child.error) console.error(child.error.code || "KEYWORD_LARGE_CHILD_FAILED"); process.exitCode = child.status ?? 1;
  } else if (args.length === 1 && args[0] === "--large-child") stress().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(JSON.stringify({ status: "failed", code: error.code || error.message })); process.exitCode = 1; });
  else if (!args.length) console.log("Skipped: explicitly use --run-large-gzip for the disposable 570MiB byte fixture.");
  else { console.error("KEYWORD_LARGE_ARGUMENTS"); process.exitCode = 1; }
}
module.exports = { stress };
