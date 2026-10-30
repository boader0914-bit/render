"use strict";
// Explicit offline coordinator. It prepares immutable partitions and a plan;
// it never imports the application or publishes a current pointer.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), child = require("node:child_process");
const MIB = 1024 * 1024, GIB = 1024 * MIB, SHA = /^[a-f0-9]{64}$/;
const LIMITS = Object.freeze({ persistent: GIB, scratch: GIB, source: 64 * MIB, metadata: 16 * MIB, output: 256 * 1024, scopeReserve: 82 * MIB, timeout: 17 * 60 * 1000, candidates: 4096 });
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canonical(v[k])])) : v;
const fingerprint = v => sha(JSON.stringify(canonical(v)));
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => ["dev", "ino", "nlink", "size", "mtimeMs", "ctimeMs"].every(k => a[k] === b[k]);
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const equalPath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root, file) => { const relative = path.relative(root, file); return relative === "" || !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative); };
function fail(code) { throw Object.assign(new Error(code), { code }); }
function need(v, code) { if (!v) fail(code); }
function validDay(s) { return typeof s === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s; }
function iso(s) { return typeof s === "string" && /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(s) && Number.isFinite(Date.parse(s)) && validDay(s.slice(0, 10)); }
function kstDay(s) { need(iso(s), "KEYWORD_PREP_CLOCK"); return new Date(Date.parse(s) + 9 * 3600000).toISOString().slice(0, 10); }
function cutoffFor(month, prepDate, capturedAt) {
  need(/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(month), "KEYWORD_PREP_MONTH");
  const [year, m] = month.split("-").map(Number), end = new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
  return [kstDay(prepDate), end, kstDay(capturedAt)].sort()[0];
}
function args(values) {
  const allowed = new Set(["code-root", "copy-root", "prepared-root", "budget-root", "discovery-complete", "capture-sha", "node-path", "node-sha", "guard-sha", "launcher-path", "python-path", "prep-date"]), result = {};
  for (let i = 0; i < values.length; i += 2) { const key = values[i]?.slice(2); need(values[i]?.startsWith("--") && allowed.has(key) && values[i + 1] && !Object.hasOwn(result, key), "KEYWORD_PREP_ARGUMENTS"); result[key] = values[i + 1]; }
  for (const key of ["code-root", "copy-root", "prepared-root", "discovery-complete", "capture-sha", "node-path", "node-sha", "guard-sha", "launcher-path", "prep-date"]) need(result[key], "KEYWORD_PREP_ARGUMENTS");
  for (const key of ["code-root", "copy-root", "prepared-root", "budget-root", "discovery-complete", "node-path", "launcher-path", "python-path"]) if (result[key]) need(path.isAbsolute(result[key]) && equalPath(path.resolve(result[key]), result[key]), "KEYWORD_PREP_ABSOLUTE_PATH");
  for (const key of ["capture-sha", "node-sha", "guard-sha"]) need(SHA.test(result[key]), "KEYWORD_PREP_SHA");
  need(iso(result["prep-date"]), "KEYWORD_PREP_CLOCK");
  result["budget-root"] ||= path.dirname(result["prepared-root"]); result["python-path"] ||= "/usr/bin/python3";
  return result;
}
async function checked(file, directory = false) {
  need(path.isAbsolute(file) && equalPath(path.resolve(file), file), "KEYWORD_PREP_UNSAFE_PATH");
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); const s = await fs.lstat(current); need(!s.isSymbolicLink() && (equalPath(current, file) || s.isDirectory()), "KEYWORD_PREP_UNSAFE_PATH"); }
  const s = await fs.lstat(file); need(directory ? s.isDirectory() : s.isFile() && s.nlink === 1, "KEYWORD_PREP_UNSAFE_PATH");
  need(equalPath(await fs.realpath(file), file), "KEYWORD_PREP_UNSAFE_PATH"); return s;
}
async function absent(file) { await checked(path.dirname(file), true); try { await fs.lstat(file); fail("KEYWORD_PREP_ALREADY_EXISTS"); } catch (e) { if (e.code !== "ENOENT") throw e; } }
async function read(file, max = LIMITS.metadata, json = true) {
  const before = await checked(file); need(before.size > 0 && before.size <= max, "KEYWORD_PREP_READ_BOUND");
  const handle = await fs.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0)); let bytes;
  try { need(same(before, await handle.stat()), "KEYWORD_PREP_READ_CHANGED"); bytes = Buffer.alloc(before.size + 1); let n = 0; while (n < bytes.length) { const r = await handle.read(bytes, n, bytes.length - n, n); if (!r.bytesRead) break; n += r.bytesRead; } bytes = bytes.subarray(0, n); need(n === before.size && same(before, await handle.stat()), "KEYWORD_PREP_READ_CHANGED"); } finally { await handle.close(); }
  need(same(before, await checked(file)), "KEYWORD_PREP_READ_CHANGED"); let value;
  if (json) { try { value = JSON.parse(bytes); } catch { fail("KEYWORD_PREP_JSON"); } }
  return { file, bytes, value, sha256: sha(bytes), stat: before };
}
async function fileHash(file, max = 256 * MIB) {
  const before = await checked(file); need(before.size > 0 && before.size <= max, "KEYWORD_PREP_READ_BOUND"); const fd = await fs.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0)), h = crypto.createHash("sha256"), buffer = Buffer.alloc(MIB); let count = 0;
  try { need(same(before, await fd.stat()), "KEYWORD_PREP_READ_CHANGED"); while (true) { const r = await fd.read(buffer, 0, buffer.length, count); if (!r.bytesRead) break; count += r.bytesRead; need(count <= max, "KEYWORD_PREP_READ_BOUND"); h.update(buffer.subarray(0, r.bytesRead)); } need(count === before.size && same(before, await fd.stat()), "KEYWORD_PREP_READ_CHANGED"); } finally { await fd.close(); }
  need(same(before, await checked(file)), "KEYWORD_PREP_READ_CHANGED"); return { file, stat: before, bytes: count, sha256: h.digest("hex") };
}
async function writeNew(file, value) { const parent = await checked(path.dirname(file), true), bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)); await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 }); need(identity(parent, await checked(path.dirname(file), true)), "KEYWORD_PREP_PARENT_CHANGED"); const actual = await fileHash(file, Math.max(bytes.length, 1)); need(actual.sha256 === sha(bytes) && actual.bytes === bytes.length, "KEYWORD_PREP_WRITE_READBACK"); return actual; }
async function mkdirNew(directory) { await absent(directory); const parent = await checked(path.dirname(directory), true); await fs.mkdir(directory, { mode: 0o700 }); need(identity(parent, await checked(path.dirname(directory), true)), "KEYWORD_PREP_PARENT_CHANGED"); return checked(directory, true); }
async function treeBytes(root, maximum = GIB) {
  let total = 0, files = 0; async function walk(dir, depth) { need(depth <= 32 && ++files <= 200000, "KEYWORD_PREP_TREE_BOUND"); const before = await checked(dir, true); total += Math.max(before.size, (before.blocks || 0) * 512); need(total <= maximum, "KEYWORD_PREP_STORAGE_BOUND");
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const f = path.join(dir, entry.name), s = await fs.lstat(f); need(!s.isSymbolicLink(), "KEYWORD_PREP_UNSAFE_PATH"); if (s.isDirectory()) await walk(f, depth + 1); else { need(s.isFile() && s.nlink === 1 && ++files <= 200000, "KEYWORD_PREP_UNSAFE_PATH"); total += Math.max(s.size, (s.blocks || 0) * 512); need(total <= maximum, "KEYWORD_PREP_STORAGE_BOUND"); } } need(identity(before, await checked(dir, true)), "KEYWORD_PREP_PARENT_CHANGED"); }
  await walk(root, 0); return { allocatedOrLogicalBytes: total, paths: files, maximumBytes: maximum };
}
function privateOpsStat(stat, uid) { need(stat.isDirectory() && (stat.mode & 0o777) === 0o700 && stat.uid === uid, "KEYWORD_PREP_OPS_PERMISSIONS"); }
async function storageScope(capture, input, { fixture = false } = {}) {
  const source = path.resolve(capture.sourceDataDir), budget = input["budget-root"], prepared = input["prepared-root"];
  // The only production write exception below DATA_DIR is the explicitly
  // authorized, date-scoped durable operations namespace. Never write into
  // the original input namespaces or route production partitions into /tmp.
  const authorized = path.join(source, "operations", "monthly-keyword-production-" + kstDay(input["prep-date"]).replaceAll("-", ""));
  if (equalPath(budget, authorized)) {
    const stat = await checked(budget, true);
    if (typeof process.getuid === "function") privateOpsStat(stat, process.getuid());
    need(inside(budget, prepared) && prepared !== budget && !inside(path.join(source, "outputs"), prepared), "KEYWORD_PREP_OPS_SCOPE");
    for (const row of capture.inputFiles || []) { need(typeof row.relative === "string", "KEYWORD_PREP_CAPTURE_INVALID"); const original = path.resolve(source, row.relative); need(inside(source, original) && !inside(budget, original) && !inside(prepared, original), "KEYWORD_PREP_OPS_INPUT_OVERLAP"); }
    return { basis: "dedicated_durable_operations_namespace", directory: authorized, privateOwnerChecked: typeof process.getuid === "function" };
  }
  // Exported test injection supports fully isolated fixture directories. It is
  // unreachable from the CLI and never permits an original DATA_DIR subtree.
  need(fixture && !inside(source, budget) && !inside(source, prepared), "KEYWORD_PREP_OPS_SCOPE");
  return { basis: "isolated_fixture_directory", directory: budget, privateOwnerChecked: false };
}
function stderrPolicy(bytes, pid) {
  if (!bytes.length) return { stderrAccepted: true, knownSqliteExperimentalWarnings: 0 };
  const lines = bytes.toString("utf8").replaceAll("\r\n", "\n").split("\n"); if (lines.at(-1) === "") lines.pop();
  const warning = `(node:${pid}) ExperimentalWarning: SQLite is an experimental feature and might change at any time`, hint = "(Use `node --trace-warnings ...` to show where the warning was created)";
  let count = 0;
  for (let i = 0; i < lines.length; i++) { if (lines[i] !== warning) return { stderrAccepted: false, knownSqliteExperimentalWarnings: 0 }; count++; if (lines[i + 1] === hint) i++; }
  return { stderrAccepted: count > 0, knownSqliteExperimentalWarnings: count };
}
function childStderrSafe(result) { return result.stderrBytes === 0 || result.stderrAccepted === true && Number.isSafeInteger(result.knownSqliteExperimentalWarnings) && result.knownSqliteExperimentalWarnings > 0; }
function runChild(executable, argv, { cwd, timeout = LIMITS.timeout, outputBound = LIMITS.output } = {}) {
  return new Promise((resolve, reject) => { let proc, timer, ended = false, output = [], errors = [], total = 0, stderrBytes = 0, denied = null;
    const end = (error, result) => { if (ended) return; ended = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    try { proc = child.spawn(executable, argv, { shell: false, cwd, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TZ: "Asia/Seoul" }, windowsHide: true }); } catch { fail("KEYWORD_PREP_CHILD_START"); }
    const stop = code => { denied ||= code; proc.kill("SIGKILL"); };
    proc.on("error", () => end(Object.assign(Error("KEYWORD_PREP_CHILD_START"), { code: "KEYWORD_PREP_CHILD_START" })));
    proc.stdout.on("data", bytes => { total += bytes.length; if (total + stderrBytes > outputBound) stop("KEYWORD_PREP_CHILD_OUTPUT_BOUND"); else output.push(bytes); });
    proc.stderr.on("data", bytes => { stderrBytes += bytes.length; if (total + stderrBytes > outputBound) stop("KEYWORD_PREP_CHILD_OUTPUT_BOUND"); else errors.push(bytes); });
    timer = setTimeout(() => stop("KEYWORD_PREP_CHILD_TIMEOUT"), timeout);
    proc.on("close", (exitCode, signal) => { if (denied) return end(Object.assign(Error(denied), { code: denied })); if (exitCode !== 0 || signal) return end(Object.assign(Error("KEYWORD_PREP_CHILD_FAILED"), { code: "KEYWORD_PREP_CHILD_FAILED", exitCode }));
      let value; try { value = JSON.parse(Buffer.concat(output).toString("utf8")); } catch { return end(Object.assign(Error("KEYWORD_PREP_CHILD_PROTOCOL"), { code: "KEYWORD_PREP_CHILD_PROTOCOL" })); }
      end(null, { exitCode, pid: proc.pid, stdout: value, stderrBytes, ...stderrPolicy(Buffer.concat(errors), proc.pid) }); });
  });
}
function zero(object, keys) { need(plain(object) && keys.every(k => object[k] === 0), "KEYWORD_PREP_SIDE_EFFECT_GATE"); }
function isolation(proof, copyRoot, input) {
  need(proof?.mode === "seccomp" && proof.noNewPrivs === true && proof.seccompMode === 2 && proof.networkFdsClosed === true && equalPath(proof.expectedRoot || "", copyRoot)
    && proof.preflightOnly === false && proof.environmentSanitizedForExec === true && proof.unrestrictedFallbackAllowed === false && proof.providerCalls === 0
    && proof.guardSha256 === input["guard-sha"] && proof.nodeSha256 === input["node-sha"] && Number.isSafeInteger(proof.pid) && proof.pid > 0
    && ["tcpSocketDenied", "udpSocketDenied", "ipv6SocketDenied"].every(k => proof.kernelProbe?.[k] === true)
    && ["socket", "socketpair", "connect", "sendto", "sendmsg"].every(k => proof.kernelProbe?.syscallsDeniedWithEperm?.[k] === true), "KEYWORD_PREP_ISOLATION_GATE");
}
function validateDiscovery(value, captureSha) {
  need(value?.state === "complete" && value.mode === "discover" && value.captureManifestSha256 === captureSha && value.malformedHistoryLines === 0 && value.syntheticCurrentMonthNotTreatedAsEvidence === true
    && Array.isArray(value.candidates) && value.candidates.length <= LIMITS.candidates && value.observationIndexMode === "exact_application_streaming_fallback", "KEYWORD_PREP_DISCOVERY_INVALID");
  zero(value, ["providerCalls", "sourceWrites", "appEntryExecutions", "operatingMutations"]); zero(value.guardMetrics, ["networkAttempts", "childProcessAttempts", "outsideCopyWriteAttempts", "outsideReadAttempts", "appEntryExecutions", "providerFactories"]);
  need(value.scratch?.deniedOperations === 0 && value.immutableCopyInputsAfter?.preserved === true && value.originalOutputVerification?.inventoryPreserved === true && value.originalOutputVerification.originalWrites === 0, "KEYWORD_PREP_DISCOVERY_INVALID");
  zero(value.originalOutputVerification.metrics, ["originalWriteAttempts", "uncapturedReadAttempts", "validationDenials"]);
  const seen = new Set(); for (const row of value.candidates) { need(plain(row) && typeof row.keyword === "string" && row.keyword.length > 0 && row.keyword.length <= 160 && !/[\u0000-\u001f\u007f]/.test(row.keyword) && /^20\d{2}-(?:0[1-9]|1[0-2])$/.test(row.month), "KEYWORD_PREP_CANDIDATE_INVALID"); const key = row.keyword + "\0" + row.month; need(!seen.has(key), "KEYWORD_PREP_DUPLICATE_CANDIDATE"); seen.add(key); } return value.candidates;
}
function validateComplete(value, request, capture, proofRead, pid) {
  need(value?.state === "complete" && fingerprint(value.currentRequest) === fingerprint({ type: "keyword", targetId: request.keyword, month: request.month, cutoffDate: request.cutoffDate })
    && value.captureManifestSha256 === capture.sha256 && value.sourceInventorySha256 === capture.value.sourceInventorySha256
    && value.dataThrough === capture.value.capturedAt && value.snapshotCapturedAt === capture.value.capturedAt && value.copiedAt === capture.value.capturedAt
    && value.captureMode === capture.value.captureMode && value.observationIndexMode === "exact_application_streaming_fallback"
    && SHA.test(value.sourceSha256) && value.sourceBytes > 0 && value.sourceBytes <= LIMITS.source, "KEYWORD_PREP_COMPLETE_INVALID");
  zero(value, ["sourceWrites", "operatingMutations", "appEntryExecutions", "providerFactories"]); zero(value.guardMetrics, ["networkAttempts", "childProcessAttempts", "outsideCopyWriteAttempts", "outsideReadAttempts", "appEntryExecutions", "providerFactories"]);
  need(value.sourceMetrics?.deniedRequires === 0 && value.scratch?.deniedOperations === 0 && value.scratch.maximumBytes === GIB && Number.isSafeInteger(value.scratch.peakReservedAndAllocatedBytes) && value.scratch.peakReservedAndAllocatedBytes >= 0 && value.scratch.peakReservedAndAllocatedBytes <= GIB
    && value.copyInputsBefore?.preserved === true && value.immutableCopyInputsAfter?.preserved === true && value.originalOutputVerification?.inventoryPreserved === true && value.originalOutputVerification.originalWrites === 0, "KEYWORD_PREP_SIDE_EFFECT_GATE");
  zero(value.originalOutputVerification.metrics, ["originalWriteAttempts", "uncapturedReadAttempts", "validationDenials"]);
  need(value.isolation?.proofSha256 === proofRead.sha256 && value.isolation.pid === proofRead.value.pid && value.isolation.pid === pid && value.isolation.tcpKernelDenied === true && value.isolation.udpKernelDenied === true, "KEYWORD_PREP_ISOLATION_GATE");
  const { previousMonthlyReportRequest } = require("./lib/monthly_report_comparison.cjs"), expected = [previousMonthlyReportRequest(value.currentRequest), value.currentRequest].map(fingerprint).sort();
  need(Array.isArray(value.records) && value.records.length === 2 && value.records.every(row => row.sameSourceFinancialAndDiagnosticParity === true && SHA.test(row.snapshotFingerprint)
    && ["observations", "rankObservations", "savedProductRecoveries"].every(key => Number.isSafeInteger(row.scopedCounts?.[key]) && row.scopedCounts[key] >= 0 && row.scopedCounts[key] <= 50000))
    && fingerprint(value.records.map(row => fingerprint(row.request)).sort()) === fingerprint(expected), "KEYWORD_PREP_RECORDS_INVALID");
  for (const key of ["companies", "runs", "observations", "rankObservations", "savedProductRecoveries"]) need(Number.isSafeInteger(value.counts?.[key]) && value.counts[key] >= 0 && value.counts[key] <= (key === "runs" ? 10000 : key === "companies" ? 1000 : 50000), "KEYWORD_PREP_COUNT_BOUND");
}
function snapshotCore(s) { return { summary: s.summary, daily: s.daily, companies: s.companies.map(c => ({ companyId: c.companyId, summary: c.summary, daily: c.daily })), selectedDigest: s.sources.digest, partialEvidence: s.sources.partialEvidence, ranks: s.ranks, quality: s.quality }; }
async function verifyProjection({ projection, completeFile, output, now, keyword, month, cutoffDate }) {
  const complete = await read(completeFile), index = await read(path.join(projection, "index.json"), MIB);
  need(index.value.sourceFingerprint === complete.value.sourceSha256 && index.value.provenance?.dataThrough === complete.value.dataThrough, "KEYWORD_PREP_INDEX_BINDING");
  const { createKeywordMonthlyAnalysis } = require("./lib/keyword_monthly_analysis.cjs"), service = createKeywordMonthlyAnalysis({ projectionDir: projection, now: () => now }), options = await service.options();
  need(options.status === "available" && options.provenance?.inputSha256 === complete.value.sourceSha256, "KEYWORD_PREP_FACTORY_UNAVAILABLE");
  const descriptor = options.keywords.find(row => row.keyword === keyword && row.stayMonths.includes(month));
  const checks = [];
  for (const record of complete.value.records) {
    const q = { keyword, month: record.request.month, cutoffDate: record.request.cutoffDate }, offered = options.keywords.some(row => row.keyword === keyword && row.stayMonths.includes(q.month));
    if (!offered) { need(["observations", "rankObservations", "savedProductRecoveries"].every(key => record.scopedCounts?.[key] === 0), "KEYWORD_PREP_OBSERVED_DESCRIPTOR_MISSING"); continue; }
    const result = await service.analyze(q); need(result.status === "available" && result.snapshot && result.provenance.inputSha256 === complete.value.sourceSha256 && result.request.cutoffDate === q.cutoffDate, "KEYWORD_PREP_FACTORY_UNAVAILABLE");
    const actual = fingerprint(snapshotCore(result.snapshot)); need(actual === record.snapshotFingerprint, "KEYWORD_PREP_FINANCIAL_PARITY_FAILED"); checks.push({ month: q.month, cutoffDate: q.cutoffDate, expectedFingerprint: record.snapshotFingerprint, actualFingerprint: actual, exact: true });
  }
  need(!descriptor || checks.some(row => row.month === month && row.cutoffDate === cutoffDate), "KEYWORD_PREP_TARGET_NOT_VERIFIED");
  const result = { schemaVersion: 1, state: descriptor ? "prepared" : "notObserved", keyword, month, cutoffDate, indexSha256: index.sha256, sourceSha256: complete.value.sourceSha256,
    reason: descriptor ? null : "TARGET_DESCRIPTOR_NOT_OBSERVED_IN_NORMALIZED_SOURCE", checks, sourceWrites: 0, providerCalls: 0, pointerPublished: false };
  await writeNew(output, result); return result;
}
async function deleteOwnedSource(file, expected, owner) {
  need(file === path.join(owner.normalization, "source.json") && inside(owner.scratchRoot, file) && path.dirname(owner.normalization) === owner.scratchRoot, "KEYWORD_PREP_DELETE_OWNERSHIP");
  const marker = await read(path.join(owner.scratchRoot, "owner.json"), 16384); need(marker.sha256 === owner.markerSha && marker.value.token === owner.token, "KEYWORD_PREP_DELETE_OWNERSHIP");
  need(identity(owner.scratchStamp, await checked(owner.scratchRoot, true)) && identity(owner.normalizationStamp, await checked(owner.normalization, true)), "KEYWORD_PREP_DELETE_OWNERSHIP");
  const fresh = await fileHash(file, LIMITS.source); need(same(fresh.stat, expected.stat) && fresh.sha256 === expected.sha256 && fresh.bytes === expected.bytes, "KEYWORD_PREP_SOURCE_CHANGED_BEFORE_DELETE");
  await fs.unlink(file); try { await fs.lstat(file); fail("KEYWORD_PREP_SOURCE_NOT_REMOVED"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  return { removed: true, onlyOwnedGeneratedSource: true, sha256: fresh.sha256, bytes: fresh.bytes };
}
async function run(values, dependencies = {}) {
  const input = args(values); need(dependencies.fixture === true || process.platform === "linux", "KEYWORD_PREP_LINUX_REQUIRED");
  const execute = dependencies.runChild || runChild, progress = dependencies.progress || (v => process.stdout.write(JSON.stringify(v) + "\n"));
  const codeRoot = input["code-root"], copyRoot = input["copy-root"], preparedRoot = input["prepared-root"], budgetRoot = input["budget-root"], guard = path.join(codeRoot, "scripts/reconstruct_keyword_monthly_source_copy.cjs"), builder = path.join(codeRoot, "scripts/build_keyword_monthly_projection.cjs"), self = path.join(codeRoot, "scripts/prepare_keyword_monthly_release.cjs");
  for (const dir of [codeRoot, copyRoot, budgetRoot, path.dirname(preparedRoot), path.join(copyRoot, "control")]) await checked(dir, true);
  need(/^keyword-monthly-source-[A-Za-z0-9_-]{8,120}$/.test(path.basename(copyRoot)) && inside(budgetRoot, preparedRoot) && preparedRoot !== budgetRoot && !inside(codeRoot, preparedRoot) && !inside(copyRoot, preparedRoot)
    && !inside(preparedRoot, copyRoot) && !inside(copyRoot, budgetRoot) && !inside(budgetRoot, copyRoot) && input["launcher-path"] === path.join(codeRoot, "scripts/launch_keyword_monthly_isolated.py")
    && inside(copyRoot, input["discovery-complete"]), "KEYWORD_PREP_SCOPE_INVALID");
  await absent(preparedRoot);
  const capture = await read(path.join(copyRoot, "control/capture-complete.json")), discovery = await read(input["discovery-complete"]);
  need(capture.sha256 === input["capture-sha"] && capture.value.state === "complete" && capture.value.copyRoot === copyRoot && capture.value.dataDir === path.join(copyRoot, "data") && iso(capture.value.capturedAt)
    && Date.parse(capture.value.capturedAt) <= Date.parse(input["prep-date"]) && capture.value.sourceWrites === 0 && capture.value.sourcePreserved === true && capture.value.physicalCopiesOnly === true
    && capture.value.wholeSourcePhysicallyCopied === false && capture.value.captureMode === "core_physical_copy_with_readonly_original_outputs" && path.isAbsolute(capture.value.sourceDataDir || "") && capture.value.originalOutputs?.root === path.join(capture.value.sourceDataDir, "outputs") && capture.value.originalOutputs.copied === false && capture.value.originalOutputs.writeAllowed === false, "KEYWORD_PREP_CAPTURE_INVALID");
  const storageAuthorization = await storageScope(capture.value, input, { fixture: dependencies.fixture === true });
  const candidates = validateDiscovery(discovery.value, capture.sha256), pins = [];
  for (const file of [guard, builder, self, input["launcher-path"], input["node-path"], input["python-path"]]) { const r = await fileHash(file); pins.push(r); }
  need(pins[0].sha256 === input["guard-sha"] && pins[4].sha256 === input["node-sha"], "KEYWORD_PREP_CODE_SHA_MISMATCH");
  async function pinCheck() { for (const pin of pins) { const r = await fileHash(pin.file); need(r.sha256 === pin.sha256 && same(pin.stat, r.stat), "KEYWORD_PREP_CODE_CHANGED"); } need(same(capture.stat, await checked(capture.file)) && same(discovery.stat, await checked(discovery.file)), "KEYWORD_PREP_INPUT_CHANGED"); }
  await treeBytes(budgetRoot, LIMITS.persistent - LIMITS.scopeReserve); await treeBytes(copyRoot, LIMITS.scratch - LIMITS.source - 8 * MIB);
  const token = crypto.randomBytes(12).toString("hex"), scratchRoot = path.join(copyRoot, "prepare-release-" + token), prepared = [], notObserved = [];
  const preparedStamp = await mkdirNew(preparedRoot), scratchStamp = await mkdirNew(scratchRoot), marker = await writeNew(path.join(scratchRoot, "owner.json"), { schemaVersion: 1, token, preparedRoot, copyRoot, prepDate: input["prep-date"], generatedBy: "prepare_keyword_monthly_release" });
  const proofRows = [];
  await writeNew(path.join(preparedRoot, "preparation-input.json"), { schemaVersion: 1, token, codeRoot, copyRoot, prepDate: input["prep-date"], captureSha256: capture.sha256, discoverySha256: discovery.sha256, candidateCount: candidates.length,
    budgetRoot, storageAuthorization, persistentMaximumBytes: GIB, scratchMaximumBytes: GIB, pins: pins.map(row => ({ file: row.file, bytes: row.bytes, sha256: row.sha256 })), pointerPublished: false });
  let active = null, planReady = false;
  try {
    for (let i = 0; i < candidates.length; i++) {
      const row = candidates[i], cutoffDate = cutoffFor(row.month, input["prep-date"], capture.value.capturedAt), request = { keyword: row.keyword, month: row.month, cutoffDate }, suffix = String(i + 1).padStart(4, "0") + "-" + sha(row.keyword + "\0" + row.month).slice(0, 16);
      active = request; await pinCheck(); await treeBytes(budgetRoot, LIMITS.persistent - LIMITS.scopeReserve); await treeBytes(copyRoot, LIMITS.scratch - LIMITS.source - 8 * MIB);
      need(identity(preparedStamp, await checked(preparedRoot, true)), "KEYWORD_PREP_PARENT_CHANGED");
      const normalization = path.join(scratchRoot, suffix), proof = path.join(copyRoot, "control", "prepare-" + token + "-" + String(i + 1) + ".json"), partRoot = path.join(preparedRoot, "part-" + suffix), projection = path.join(partRoot, "projection"); await absent(normalization); await absent(proof); await mkdirNew(partRoot);
      progress({ stage: "normalizing", keyword: row.keyword, month: row.month, count: i + 1 });
      const normalized = await execute(input["python-path"], [input["launcher-path"], "--copy-root", copyRoot, "--proof", proof, "--code-root", codeRoot, "--guard-sha256", input["guard-sha"], "--node-sha256", input["node-sha"], "--", input["node-path"], guard,
        "--mode", "normalize", "--copy-root", copyRoot, "--code-root", codeRoot, "--isolation-proof", proof, "--expected-capture-sha", capture.sha256, "--keyword", row.keyword, "--month", row.month, "--cutoff", cutoffDate, "--output", normalization], { cwd: codeRoot });
      need(normalized.exitCode === 0 && childStderrSafe(normalized) && normalized.stdout?.state === "complete", "KEYWORD_PREP_NORMALIZE_CHILD_FAILED");
      const normalizationStamp = await checked(normalization, true), proofRead = await read(proof, 65536), complete = await read(path.join(normalization, "reconstruction-complete.json")), provenance = await read(path.join(normalization, "provenance.json"), 65536);
      isolation(proofRead.value, copyRoot, input); validateComplete(complete.value, request, capture, proofRead, normalized.pid);
      need(complete.value.sourceFile === path.join(normalization, "source.json") && normalized.stdout.sourceSha256 === complete.value.sourceSha256 && normalized.stdout.sourceBytes === complete.value.sourceBytes, "KEYWORD_PREP_SOURCE_BINDING");
      const source = await fileHash(complete.value.sourceFile, LIMITS.source);
      need(source.sha256 === complete.value.sourceSha256 && source.bytes === complete.value.sourceBytes && provenance.value.inputSha256 === source.sha256 && provenance.value.inputBytes === source.bytes
        && provenance.value.copiedAt === capture.value.capturedAt && provenance.value.observationScope === "normalized_multirun" && fingerprint(provenance.value.normalizationCutoffs) === fingerprint(Object.fromEntries(complete.value.records.map(r => [r.request.month, r.request.cutoffDate]))), "KEYWORD_PREP_SOURCE_BINDING");
      progress({ stage: "building", keyword: row.keyword, month: row.month, count: i + 1, sha256: source.sha256 });
      const built = await execute(input["node-path"], ["--max-old-space-size=768", builder, "--source", source.file, "--output", projection, "--now", input["prep-date"], "--data-through", capture.value.capturedAt, "--copied-at", capture.value.capturedAt, "--provenance", provenance.file, "--compression", "gzip"], { cwd: codeRoot });
      need(built.exitCode === 0 && childStderrSafe(built) && built.stdout?.sourceUnchanged === true && built.stdout.provenanceUnchanged === true && built.stdout.sourceFingerprint === source.sha256 && built.stdout.projectionDir === projection
        && built.stdout.explicitOfflinePreparation === true && built.stdout.providerCalls === 0 && built.stdout.kosisReadOrChanged === false, "KEYWORD_PREP_BUILD_CHILD_FAILED");
      const index = await read(path.join(projection, "index.json"), MIB); need(index.sha256 === built.stdout.indexSha256 && built.stdout.scopeCount <= 2 && index.value.keywords.every(k => k.keyword === row.keyword && k.scopes.every(scope => scope.encoding === "gzip")), "KEYWORD_PREP_INDEX_BINDING");
      const verifyOutput = path.join(partRoot, "factory-verification.json"), verified = await execute(input["node-path"], ["--max-old-space-size=512", self, "--verify-child", projection, complete.file, verifyOutput, input["prep-date"], row.keyword, row.month, cutoffDate], { cwd: codeRoot });
      need(verified.exitCode === 0 && childStderrSafe(verified), "KEYWORD_PREP_VERIFY_CHILD_FAILED"); const verification = await read(verifyOutput, 65536);
      need(fingerprint(verification.value) === fingerprint(verified.stdout) && verification.value.indexSha256 === index.sha256 && verification.value.sourceSha256 === source.sha256 && ["prepared", "notObserved"].includes(verification.value.state), "KEYWORD_PREP_VERIFY_BINDING");
      for (const [name, data] of [["reconstruction-complete.json", complete], ["provenance.json", provenance], ["isolation-proof.json", proofRead]]) { need(same(data.stat, await checked(data.file)), "KEYWORD_PREP_INPUT_CHANGED"); await writeNew(path.join(partRoot, name), data.bytes); }
      await writeNew(path.join(partRoot, "child-output-policy.json"), { state: "verified", exitCodes: [normalized.exitCode, built.exitCode, verified.exitCode], stderrPolicy: "only_exact_same_pid_sqlite_experimental_warning_permitted_after_exit_zero",
        knownSqliteExperimentalWarnings: [normalized, built, verified].map(r => r.knownSqliteExperimentalWarnings || 0), stderrBytes: [normalized.stderrBytes, built.stderrBytes, verified.stderrBytes], unexpectedStderrAccepted: false });
      await treeBytes(budgetRoot, LIMITS.persistent); await pinCheck();
      const cleanup = await deleteOwnedSource(source.file, source, { normalization, scratchRoot, token, markerSha: marker.sha256, scratchStamp, normalizationStamp });
      await writeNew(path.join(partRoot, "source-cleanup.json"), cleanup);
      const item = { ...request, directory: projection, indexSha256: index.sha256, sourceSha256: source.sha256, completeSha256: complete.sha256, verificationSha256: verification.sha256 };
      if (verification.value.state === "prepared") prepared.push(item); else notObserved.push({ ...item, reason: verification.value.reason });
      proofRows.push({ keyword: row.keyword, month: row.month, state: verification.value.state, indexSha256: index.sha256, sourceSha256: source.sha256 });
      progress({ stage: verification.value.state, keyword: row.keyword, month: row.month, count: i + 1, sha256: index.sha256 });
    }
    await pinCheck(); await treeBytes(budgetRoot, LIMITS.persistent - MIB);
    const plan = { schemaVersion: 1, inputs: prepared.map(row => ({ directory: row.directory, exposeScopes: [{ keyword: row.keyword, month: row.month }] })) };
    const planFile = path.join(preparedRoot, "bundle-plan.json"), planRead = await writeNew(planFile, plan); planReady = true;
    const result = { schemaVersion: 1, state: "complete", preparationOnly: true, pointerPublished: false, candidateCount: candidates.length, preparedCount: prepared.length, notObservedCount: notObserved.length,
      candidatesReconciled: candidates.length === prepared.length + notObserved.length, prepared, notObserved, planFile, planSha256: planRead.sha256, captureSha256: capture.sha256, discoverySha256: discovery.sha256,
      scopeProofDigest: fingerprint(proofRows), persistent: await treeBytes(budgetRoot, LIMITS.persistent), sourceWrites: 0, providerCalls: 0, operatingMutations: 0 };
    await writeNew(path.join(preparedRoot, "preparation-complete.json"), result); progress({ stage: "complete", count: candidates.length, preparedCount: prepared.length, notObservedCount: notObserved.length, sha256: planRead.sha256 }); return result;
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]+$/.test(error.code || "") ? error.code : "KEYWORD_PREP_FAILED";
    try { await writeNew(path.join(preparedRoot, "preparation-failed.json"), { schemaVersion: 1, state: "failed", code, active, verifiedButNotPublishedCount: prepared.length, notObservedCount: notObserved.length,
      pointerPublished: false, preparationComplete: false, noSuccessPlan: !planReady, planRequiresReadback: planReady, partialNewArtifactsRetained: true }); } catch {}
    fail(code);
  }
}
if (require.main === module) {
  const v = process.argv.slice(2);
  Promise.resolve().then(() => { if (v[0] !== "--verify-child") return run(v); need(v.length === 8 && iso(v[4]), "KEYWORD_PREP_ARGUMENTS"); return verifyProjection({ projection: v[1], completeFile: v[2], output: v[3], now: v[4], keyword: v[5], month: v[6], cutoffDate: v[7] }); })
    .then(result => { if (v[0] === "--verify-child") process.stdout.write(JSON.stringify(result) + "\n"); }).catch(error => { process.stderr.write(JSON.stringify({ code: /^[A-Z][A-Z0-9_]+$/.test(error.code || "") ? error.code : "KEYWORD_PREP_FAILED" }) + "\n"); process.exitCode = 1; });
}
module.exports = { args, cutoffFor, checked, read, fileHash, treeBytes, writeNew, privateOpsStat, storageScope, stderrPolicy, childStderrSafe, runChild, validateDiscovery, validateComplete, snapshotCore, fingerprint, verifyProjection, deleteOwnedSource, run, LIMITS };
