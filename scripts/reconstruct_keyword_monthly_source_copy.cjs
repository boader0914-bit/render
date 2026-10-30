"use strict";
// Explicit normalization of a freshly captured private physical copy. This is
// never called by a GET, scheduled collector, startup hook or provider.
const native = require("node:fs"), fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { safeJson, checkedPath } = require("./lib/keyword_monthly_source_copy.cjs");
const { installReadOnlyOutputs } = require("./lib/keyword_monthly_readonly_outputs.cjs");
const { installScratchBudget } = require("./lib/keyword_monthly_scratch_budget.cjs");
const MAX_SOURCE_BYTES = 64 * 1024 * 1024, MAX_ROWS = 50000, MAX_TIME_MS = 15 * 60 * 1000;
const SHA = /^[a-f0-9]{64}$/, PRIVATE = /(?:token|secret|password|cookie|authorization|private|rawPayload|guest|customer|contact|address|account|kosis|context)/i;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const fingerprint = value => sha(JSON.stringify(canonical(value))), multiset = rows => fingerprint(rows.map(fingerprint).sort());
const inside = (root, file) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
function fail(code) { throw Object.assign(new Error(code), { code }); }
function need(value, code) { if (!value) fail(code); }
function args(values) {
  const result = {}, allowed = new Set(["mode", "copy-root", "code-root", "isolation-proof", "keyword", "month", "cutoff", "output", "expected-capture-sha"]);
  for (let i = 0; i < values.length; i += 2) { const key = values[i]?.replace(/^--/, ""); need(values[i]?.startsWith("--") && allowed.has(key) && values[i + 1] && !Object.hasOwn(result, key), "KEYWORD_RECONSTRUCT_ARGUMENTS"); result[key] = values[i + 1]; }
  result.mode ||= "normalize"; need(["normalize", "discover"].includes(result.mode) && ["copy-root", "code-root", "isolation-proof", "output", "expected-capture-sha"].every(key => result[key]), "KEYWORD_RECONSTRUCT_ARGUMENTS");
  for (const key of ["copy-root", "code-root", "isolation-proof", "output"]) need(path.isAbsolute(result[key]), "KEYWORD_RECONSTRUCT_ABSOLUTE_PATH_REQUIRED");
  need(SHA.test(result["expected-capture-sha"]), "KEYWORD_RECONSTRUCT_ARGUMENTS");
  if (result.mode === "normalize") need(/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(result.month) && /^20\d{2}-\d{2}-\d{2}$/.test(result.cutoff)
    && Number.isFinite(Date.parse(result.cutoff + "T00:00:00Z")) && result.keyword.length <= 160 && !/[\u0000-\u001f\u007f]/.test(result.keyword), "KEYWORD_RECONSTRUCT_ARGUMENTS");
  return result;
}
async function kernelIsolation(proofFile, copyRoot) {
  need(process.platform === "linux", "KEYWORD_RECONSTRUCT_LINUX_ISOLATION_REQUIRED");
  const proof = await safeJson(proofFile, 64 * 1024), value = proof.value;
  need(value?.mode === "seccomp" && value.pid === process.pid && value.noNewPrivs === true && value.seccompMode === 2
    && value.networkFdsClosed === true && path.resolve(value.expectedRoot || "") === copyRoot
    && ["socket", "socketpair", "connect", "sendto", "sendmsg"].every(name => value.blockedSyscalls?.includes(name)), "KEYWORD_RECONSTRUCT_ISOLATION_PROOF_INVALID");
  const status = await fs.readFile("/proc/self/status", "utf8"); need(/^NoNewPrivs:\s+1$/m.test(status) && /^Seccomp:\s+2$/m.test(status), "KEYWORD_RECONSTRUCT_KERNEL_FILTER_MISSING");
  // Localhost probes cannot contact a provider. Kernel denial must happen
  // before the JavaScript network guards below are installed.
  const net = require("node:net"), dgram = require("node:dgram");
  const tcp = await new Promise(resolve => { const socket = net.createConnection({ host: "127.0.0.1", port: 9 }); const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1000); socket.once("error", error => { clearTimeout(timer); socket.destroy(); resolve(["EPERM", "EACCES"].includes(error.code)); }); socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(false); }); });
  const udp = await new Promise(resolve => { let socket; try { socket = dgram.createSocket("udp4"); } catch (error) { resolve(["EPERM", "EACCES"].includes(error.code)); return; } const timer = setTimeout(() => { socket.close(); resolve(false); }, 1000); socket.once("error", error => { clearTimeout(timer); try { socket.close(); } catch {} resolve(["EPERM", "EACCES"].includes(error.code)); }); socket.bind(0, "127.0.0.1", () => { clearTimeout(timer); socket.close(); resolve(false); }); });
  need(tcp && udp, "KEYWORD_RECONSTRUCT_KERNEL_NETWORK_PROBE_FAILED");
  return { mode: "seccomp", proofSha256: proof.sha256, pid: process.pid, noNewPrivs: true, seccompMode: 2, networkFdsClosed: true, tcpKernelDenied: true, udpKernelDenied: true };
}
function installGuards(copyRoot, { codeRoot = null, originalOutputs = null } = {}) {
  const metrics = { networkAttempts: 0, childProcessAttempts: 0, outsideCopyWriteAttempts: 0, outsideReadAttempts: 0, appEntryExecutions: 0, providerFactories: 0 }, restore = [];
  const originalLstat = native.lstatSync.bind(native), originalReaddir = native.readdirSync.bind(native), codeFiles = new Set(), codeDirectories = new Set(), outputFiles = new Set(), outputDirectories = new Set(), ancestorStats = new Set(), allowedDescriptors = new Set();
  for (const approved of [copyRoot, codeRoot, originalOutputs?.root].filter(Boolean)) { let parent = path.resolve(approved); while (true) { ancestorStats.add(parent); const next = path.dirname(parent); if (next === parent) break; parent = next; } }
  const addParents = (set, filename, root) => { let current = path.dirname(filename); while (inside(root, current)) { set.add(current); if (current === root) break; current = path.dirname(current); } };
  if (codeRoot) {
    codeRoot = path.resolve(codeRoot);
    for (const directory of [path.join(codeRoot, "scripts"), path.join(codeRoot, "scripts/lib")]) for (const entry of originalReaddir(directory, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith(".cjs")) codeFiles.add(path.join(directory, entry.name));
    for (const name of ["package.json", "scripts/verified_room_inventory.json", "web/data/region_master.json", "web/data/tourism_region_map.json"]) codeFiles.add(path.join(codeRoot, ...name.split("/")));
    for (const file of codeFiles) addParents(codeDirectories, file, codeRoot);
  }
  if (originalOutputs) {
    for (const row of originalOutputs.files) { const file = path.join(originalOutputs.root, ...row.relative.split("/")); outputFiles.add(file); addParents(outputDirectories, file, originalOutputs.root); }
    outputDirectories.add(originalOutputs.root);
  }
  const systemFiles = new Set(["/proc/self/status", "/sys/fs/cgroup/memory.stat", "/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes", "/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.events"].map(value => path.resolve(value)));
  function assertRead(value, metadata = false) {
    if (typeof value === "number") { if (!allowedDescriptors.has(value)) { metrics.outsideReadAttempts++; fail("KEYWORD_RECONSTRUCT_OUTSIDE_READ_DENIED"); } return; }
    const filename = value instanceof URL ? require("node:url").fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
    const file = typeof filename === "string" ? path.resolve(filename) : null;
    let expectedMissingOutput = false;
    if (file && originalOutputs && inside(originalOutputs.root, file) && !outputFiles.has(file) && !outputDirectories.has(file)) {
      try { originalLstat(file); } catch (error) { if (error.code === "ENOENT") expectedMissingOutput = true; else throw error; }
    }
    if (!file || !inside(copyRoot, file) && !codeFiles.has(file) && !(metadata && codeDirectories.has(file)) && !outputFiles.has(file) && !(metadata && outputDirectories.has(file))
      && !(metadata === "ancestors" && ancestorStats.has(file)) && !expectedMissingOutput && !systemFiles.has(file)) {
      metrics.outsideReadAttempts++; fail("KEYWORD_RECONSTRUCT_OUTSIDE_READ_DENIED");
    }
    if (systemFiles.has(file)) return;
    let current = path.parse(file).root;
    for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part); let stat;
      try { stat = originalLstat(current); } catch (error) { if (error.code === "ENOENT") break; throw error; }
      if (stat.isSymbolicLink() || current !== file && !stat.isDirectory()) { metrics.outsideReadAttempts++; fail("KEYWORD_RECONSTRUCT_READ_SYMLINK_DENIED"); }
    }
  }
  function replace(object, key, value) { const before = object[key]; object[key] = value; restore.push(() => { object[key] = before; }); }
  const denied = code => () => { metrics[code === "KEYWORD_RECONSTRUCT_NETWORK_DENIED" ? "networkAttempts" : "childProcessAttempts"]++; fail(code); };
  replace(globalThis, "fetch", denied("KEYWORD_RECONSTRUCT_NETWORK_DENIED"));
  for (const name of ["node:http", "node:https"]) for (const key of ["request", "get"]) replace(require(name), key, denied("KEYWORD_RECONSTRUCT_NETWORK_DENIED"));
  const net = require("node:net"); for (const key of ["connect", "createConnection"]) replace(net, key, denied("KEYWORD_RECONSTRUCT_NETWORK_DENIED"));
  replace(net.Socket.prototype, "connect", denied("KEYWORD_RECONSTRUCT_NETWORK_DENIED")); replace(net.Server.prototype, "listen", denied("KEYWORD_RECONSTRUCT_NETWORK_DENIED"));
  replace(require("node:tls"), "connect", denied("KEYWORD_RECONSTRUCT_NETWORK_DENIED"));
  const cp = require("node:child_process"); for (const key of ["exec", "execFile", "spawn", "fork", "execSync", "execFileSync", "spawnSync"]) replace(cp, key, denied("KEYWORD_RECONSTRUCT_CHILD_PROCESS_DENIED"));
  const assertWrite = value => {
    if (typeof value === "number") return;
    const file = value instanceof URL ? require("node:url").fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
    if (typeof file !== "string" || !inside(copyRoot, path.resolve(file))) { metrics.outsideCopyWriteAttempts++; fail("KEYWORD_RECONSTRUCT_OUTSIDE_COPY_WRITE_DENIED"); }
  };
  const writing = flags => typeof flags === "number" ? Boolean(flags & (native.constants.O_WRONLY | native.constants.O_RDWR | native.constants.O_CREAT | native.constants.O_TRUNC | native.constants.O_APPEND)) : /[wa+]/.test(String(flags));
  for (const object of [native, fs]) {
    for (const name of ["writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink", "chmod", "chown", "truncate", "utimes", "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "rmdirSync", "unlinkSync", "chmodSync", "chownSync", "truncateSync", "utimesSync"]) if (typeof object[name] === "function") {
      const original = object[name]; replace(object, name, (...values) => { assertWrite(values[0]); return original.apply(object, values); });
    }
    for (const name of ["rename", "renameSync", "link", "linkSync", "symlink", "symlinkSync"]) if (typeof object[name] === "function") { const original = object[name]; replace(object, name, (...values) => { assertWrite(values[0]); assertWrite(values[1]); return original.apply(object, values); }); }
    for (const name of ["copyFile", "copyFileSync"]) if (typeof object[name] === "function") { const original = object[name]; replace(object, name, (...values) => { assertRead(values[0]); assertWrite(values[1]); return original.apply(object, values); }); }
    for (const name of ["open", "openSync"]) if (typeof object[name] === "function") { const original = object[name]; replace(object, name, (...values) => {
      if (writing(values[1])) assertWrite(values[0]); else assertRead(values[0]);
      if (name === "openSync") { const fd = original.apply(object, values); allowedDescriptors.add(fd); return fd; }
      if (object === fs) return original.apply(object, values).then(handle => { allowedDescriptors.add(handle.fd); const close = handle.close.bind(handle); handle.close = async () => { const fd = handle.fd; try { return await close(); } finally { allowedDescriptors.delete(fd); } }; return handle; });
      const callback = values.at(-1); if (typeof callback === "function") values[values.length - 1] = (error, fd) => { if (!error) allowedDescriptors.add(fd); callback(error, fd); };
      return original.apply(object, values);
    }); }
    for (const name of ["readFile", "readFileSync", "createReadStream"]) if (typeof object[name] === "function") { const original = object[name]; replace(object, name, (...values) => { assertRead(values[0]); return original.apply(object, values); }); }
    for (const name of ["stat", "statSync", "lstat", "lstatSync", "access", "accessSync", "existsSync", "readdir", "readdirSync", "realpath", "realpathSync", "readlink", "readlinkSync"]) if (typeof object[name] === "function") { const original = object[name]; replace(object, name, (...values) => { assertRead(values[0], /^(?:stat|lstat|realpath)/.test(name) ? "ancestors" : true); return original.apply(object, values); }); }
  }
  for (const name of ["close", "closeSync"]) { const original = native[name]; replace(native, name, (fd, ...rest) => { if (name === "closeSync") { try { return original(fd, ...rest); } finally { allowedDescriptors.delete(fd); } } const callback = rest.at(-1); if (typeof callback === "function") rest[rest.length - 1] = error => { allowedDescriptors.delete(fd); callback(error); }; return original(fd, ...rest); }); }
  return { metrics, restore() { for (const operation of restore.reverse()) operation(); } };
}
function publicSource(value, removed, location = "") {
  if (Array.isArray(value)) return value.map(item => publicSource(item, removed, location + "[]"));
  if (value && typeof value === "object") { const result = {}; for (const [key, item] of Object.entries(value)) { if (PRIVATE.test(key)) { removed[location + "." + key] = (removed[location + "." + key] || 0) + 1; continue; } result[key] = publicSource(item, removed, location + "." + key); } return result; }
  return value;
}
function snapshotCore(snapshot) {
  return { summary: snapshot.summary, daily: snapshot.daily, companies: snapshot.companies.map(company => ({ companyId: company.companyId, summary: company.summary, daily: company.daily })),
    selectedDigest: snapshot.sources.digest, partialEvidence: snapshot.sources.partialEvidence, ranks: snapshot.ranks, quality: snapshot.quality };
}
async function verifyCopyInputs(copyRoot, capture, { immutableOnly = false, started = Date.now() } = {}) {
  const rows = [], buffer = Buffer.alloc(1024 * 1024);
  for (const row of capture.inputFiles) {
    if (immutableOnly && !/^(?:company_master\/|history\/observations\.jsonl$|history\/saved_product_recoveries\/|history\/special_days\/|outputs\/)/.test(row.relative)) continue;
    need(Date.now() - started <= MAX_TIME_MS, "KEYWORD_RECONSTRUCT_TIME_BOUND");
    const filename = path.join(copyRoot, "data", ...row.relative.split("/")); need(inside(path.join(copyRoot, "data"), filename), "KEYWORD_RECONSTRUCT_CAPTURE_PATH_INVALID");
    const before = await checkedPath(filename); need(Number(before.size) === row.bytes, "KEYWORD_RECONSTRUCT_COPY_CHANGED");
    const handle = await fs.open(filename, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0)), h = crypto.createHash("sha256"); let position = 0;
    try { while (true) { const result = await handle.read(buffer, 0, buffer.length, position); if (!result.bytesRead) break; h.update(buffer.subarray(0, result.bytesRead)); position += result.bytesRead; } }
    finally { await handle.close(); }
    need(position === row.bytes && h.digest("hex") === row.sha256, "KEYWORD_RECONSTRUCT_COPY_CHANGED"); rows.push([row.relative, row.bytes, row.sha256]);
  }
  return { files: rows.length, bytes: rows.reduce((sum, row) => sum + row[1], 0), multisetSha256: fingerprint(rows), preserved: true };
}
async function run(values) {
  const input = args(values), root = path.resolve(input["copy-root"]), codeRoot = path.resolve(input["code-root"]), output = path.resolve(input.output), started = Date.now();
  await checkedPath(root, true); await checkedPath(codeRoot, true);
  need(/^keyword-monthly-source-[A-Za-z0-9_-]{8,120}$/.test(path.basename(root)) && inside(root, output) && output !== root
    && inside(path.join(root, "control"), path.resolve(input["isolation-proof"])), "KEYWORD_RECONSTRUCT_SCOPE_INVALID");
  const captured = await safeJson(path.join(root, "control", "capture-complete.json"), 16 * 1024 * 1024), capture = captured.value;
  need(captured.sha256 === input["expected-capture-sha"] && capture.state === "complete" && capture.copyRoot === root && capture.dataDir === path.join(root, "data")
    && capture.sourceWrites === 0 && capture.physicalCopiesOnly === true && capture.captureMode === "core_physical_copy_with_readonly_original_outputs"
    && capture.originalOutputs?.root === path.join(capture.sourceDataDir, "outputs") && capture.originalOutputs.copied === false
    && !inside(path.resolve(capture.sourceDataDir), root), "KEYWORD_RECONSTRUCT_CAPTURE_INVALID");
  const isolation = await kernelIsolation(input["isolation-proof"], root), guards = installGuards(root, { codeRoot, originalOutputs: capture.originalOutputs }), removed = {};
  const outputs = installReadOnlyOutputs(capture.originalOutputs), scratch = installScratchBudget(root);
  try {
    await outputs.assertInventoryCurrent();
    // Only private derived capacity/catalog/cache files may evolve. Raw
    // physical master/history/calendar/recovery copies remain byte-identical.
    const before = await verifyCopyInputs(root, capture, { immutableOnly: true, started }); await fs.mkdir(output, { mode: 0o700 });
    const { buildSourceWiring } = require("./lib/keyword_monthly_source_wiring.cjs"), wiring = buildSourceWiring({ codeRoot, copyDataDir: capture.dataDir, now: capture.capturedAt,
      readOnlyOriginalOutputs: capture.originalOutputs.root, streamHistoryOnly: true });
    const req = require("node:module").createRequire(path.join(codeRoot, "scripts", "glamping_app_server.cjs"));
    const { monthlyReportKeywordMembership, buildMonthlyReportSnapshot } = req("./lib/monthly_reports.cjs"), { previousMonthlyReportRequest } = req("./lib/monthly_report_comparison.cjs");
    if (input.mode === "discover") {
      const options = await wiring.sources.options({ priority: "foreground" }), runs = await wiring.listRuns(), allowed = new Set(options.keywords.map(row => row.id)), runMap = new Map(runs.map(row => [String(row.id || row.runId), row]));
      const candidates = new Map(), add = (keyword, month, field) => {
        if (!allowed.has(keyword) || !/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(month)) return;
        const key = JSON.stringify([keyword, month]), row = candidates.get(key) || { keyword, month, historyRows: 0, requestedRunCoverage: 0, rankRunCandidates: 0, normalizedObserved: null };
        row[field]++; candidates.set(key, row); need(candidates.size <= 1200, "KEYWORD_RECONSTRUCT_CANDIDATE_BOUND");
      };
      const readline = require("node:readline"), stream = native.createReadStream(path.join(capture.dataDir, "history/observations.jsonl"), { encoding: "utf8", highWaterMark: 64 * 1024 }), lines = readline.createInterface({ input: stream, crlfDelay: Infinity }); let malformedLines = 0;
      try { for await (const line of lines) { need(Buffer.byteLength(line) <= 1024 * 1024 && Date.now() - started <= MAX_TIME_MS, "KEYWORD_RECONSTRUCT_DISCOVERY_BOUND"); if (!line.trim()) continue; let row; try { row = JSON.parse(line.replace(/^\uFEFF/, "")); } catch { malformedLines++; continue; } const run = runMap.get(String(row?.runId || "")); add(String(row?.keyword || run?.keyword || ""), String(row?.stayDate || row?.date || "").slice(0, 7), "historyRows"); } } finally { lines.close(); stream.destroy(); }
      for (const run of runs) {
        if (!allowed.has(run.keyword)) continue;
        const start = Date.parse(String(run.checkIn || "") + "T00:00:00Z"), days = Number(run.bookingRangeDays);
        if (Number.isFinite(start) && Number.isSafeInteger(days) && days > 0 && days <= 366) {
          const covered = new Set(); for (let day = 0; day < days; day++) covered.add(new Date(start + day * 86400000).toISOString().slice(0, 7));
          for (const month of covered) add(run.keyword, month, "requestedRunCoverage");
        }
        if (Number.isFinite(Date.parse(run.collectedAt)) && run.collectedAtSource !== "filesystem") add(run.keyword, new Date(Date.parse(run.collectedAt) + 9 * 3600000).toISOString().slice(0, 7), "rankRunCandidates");
      }
      need(malformedLines === 0, "KEYWORD_RECONSTRUCT_DISCOVERY_MALFORMED_HISTORY");
      const originalOutputVerification = await outputs.verify(), after = await verifyCopyInputs(root, capture, { immutableOnly: true, started }); wiring.assertCodeCurrent(); scratch.assertCurrent();
      need(!guards.metrics.networkAttempts && !guards.metrics.childProcessAttempts && !guards.metrics.outsideCopyWriteAttempts && !guards.metrics.outsideReadAttempts
        && !wiring.metrics.deniedRequires && !outputs.metrics.originalWriteAttempts && !outputs.metrics.uncapturedReadAttempts && !outputs.metrics.validationDenials && !scratch.status().deniedOperations, "KEYWORD_RECONSTRUCT_SIDE_EFFECT_ATTEMPTED");
      const result = { schemaVersion: 1, mode: "discover", state: "complete", copiedAt: capture.capturedAt, captureManifestSha256: captured.sha256,
        candidateBasis: "exact_saved_selector_keywords_and_actual_history_or_recorded_run_coverage; every_pair_requires_normalization", candidates: [...candidates.values()].sort((a, b) => a.keyword.localeCompare(b.keyword) || a.month.localeCompare(b.month)),
        malformedHistoryLines: malformedLines, keywordCount: allowed.size, globalSelectorMonths: options.months, syntheticCurrentMonthNotTreatedAsEvidence: true, originalOutputVerification, isolation,
        observationIndexMode: "exact_application_streaming_fallback", immutableCopyInputsAfter: after, guardMetrics: guards.metrics, scratch: scratch.status(), providerCalls: 0, sourceWrites: 0, appEntryExecutions: 0, operatingMutations: 0, elapsedMs: Date.now() - started };
      await fs.writeFile(path.join(output, "discovery-complete.json"), JSON.stringify(result), { flag: "wx", mode: 0o600 });
      return { mode: "discover", state: "complete", output: path.join(output, "discovery-complete.json"), keywordCount: result.keywordCount, candidates: result.candidates,
        providerCalls: 0, operatingMutations: 0, appEntryExecutions: 0, elapsedMs: result.elapsedMs };
    }
    const current = { type: "keyword", targetId: input.keyword, month: input.month, cutoffDate: input.cutoff }, requests = [previousMonthlyReportRequest(current), current];
    const months = new Set(requests.map(request => request.month)), source = { companies: [], runs: [], observations: [], rankObservations: [], savedProductRecoveries: [], warnings: [], sourceDiagnostics: {}, monthlySourceMetadata: {} };
    const companies = new Map(), runs = new Map(), ranks = new Set(), records = [];
    for (const request of requests) {
      need(Date.now() - started <= MAX_TIME_MS, "KEYWORD_RECONSTRUCT_TIME_BOUND");
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), Math.max(1, MAX_TIME_MS - (Date.now() - started)));
      let full;
      try { full = await wiring.sources.loadSources(request, { includeContext: false, priority: "foreground", signal: controller.signal }); }
      finally { clearTimeout(timeout); }
      const runMap = new Map(full.runs.map(run => [String(run.id || run.runId), run]));
      const keyword = row => String(row.keyword || runMap.get(String(row.runId || ""))?.keyword || "");
      const inScope = { ...full, observations: full.observations.filter(row => keyword(row) === input.keyword), rankObservations: (full.rankObservations || []).filter(row => {
        const time = Date.parse(row.collectedAt || runMap.get(String(row.runId))?.collectedAt);
        return keyword(row) === input.keyword && Number.isFinite(time) && months.has(new Date(time + 9 * 3600000).toISOString().slice(0, 7)); }),
      savedProductRecoveries: (full.savedProductRecoveries || []).filter(entry => keyword(entry.row) === input.keyword) };
      const membership = monthlyReportKeywordMembership(request, inScope); inScope.companies = full.companies.filter(company => membership.members.has(company.companyId));
      const ids = new Set([...inScope.observations, ...inScope.rankObservations, ...inScope.savedProductRecoveries.map(entry => entry.row)].map(row => String(row.runId || "")));
      inScope.runs = full.runs.filter(run => ids.has(String(run.id || run.runId)) || run.keyword === input.keyword);
      const safe = publicSource(inScope, removed), expected = snapshotCore(buildMonthlyReportSnapshot(request, full, capture.capturedAt)), actual = snapshotCore(buildMonthlyReportSnapshot(request, safe, capture.capturedAt));
      need(fingerprint(expected) === fingerprint(actual), "KEYWORD_RECONSTRUCT_PUBLIC_PARITY_FAILED");
      for (const row of safe.companies) companies.set(row.companyId, row); for (const row of safe.runs) runs.set(row.id || row.runId, row);
      source.observations.push(...safe.observations); source.savedProductRecoveries.push(...safe.savedProductRecoveries);
      for (const row of safe.rankObservations) { const hash = fingerprint(row); if (!ranks.has(hash)) { ranks.add(hash); source.rankObservations.push(row); } }
      source.monthlySourceMetadata[request.month] = { warnings: safe.warnings || [], sourceDiagnostics: safe.sourceDiagnostics || {}, globalWarnings: safe.globalWarnings || [], globalDiagnostics: safe.globalDiagnostics || {} };
      if (safe.specialDays) source.specialDays = safe.specialDays;
      records.push({ request, fullCounts: Object.fromEntries(["companies", "runs", "observations", "rankObservations", "savedProductRecoveries"].map(key => [key, (full[key] || []).length])),
        scopedCounts: Object.fromEntries(["companies", "runs", "observations", "rankObservations", "savedProductRecoveries"].map(key => [key, (safe[key] || []).length])),
        scopedMultisets: Object.fromEntries(["observations", "rankObservations", "savedProductRecoveries"].map(key => [key, multiset(safe[key] || [])])), sameSourceFinancialAndDiagnosticParity: true, snapshotFingerprint: fingerprint(actual) });
    }
    source.companies = [...companies.values()]; source.runs = [...runs.values()];
    need(source.observations.length <= MAX_ROWS && source.rankObservations.length <= MAX_ROWS && source.savedProductRecoveries.length <= MAX_ROWS, "KEYWORD_RECONSTRUCT_ROW_BOUND");
    const bytes = Buffer.from(JSON.stringify(source)); need(bytes.length <= MAX_SOURCE_BYTES, "KEYWORD_RECONSTRUCT_SOURCE_64MIB_BOUND");
    const after = await verifyCopyInputs(root, capture, { immutableOnly: true, started }), originalOutputVerification = await outputs.verify(); wiring.assertCodeCurrent(); scratch.assertCurrent();
    need(!guards.metrics.networkAttempts && !guards.metrics.childProcessAttempts && !guards.metrics.outsideCopyWriteAttempts && !guards.metrics.outsideReadAttempts && !wiring.metrics.deniedRequires
      && !outputs.metrics.originalWriteAttempts && !outputs.metrics.uncapturedReadAttempts && !outputs.metrics.validationDenials && !scratch.status().deniedOperations, "KEYWORD_RECONSTRUCT_SIDE_EFFECT_ATTEMPTED");
    const sourceFile = path.join(output, "source.json"), provenance = { inputSha256: sha(bytes), inputBytes: bytes.length, copiedAt: capture.capturedAt, observationScope: "normalized_multirun",
      normalizationCutoffs: Object.fromEntries(requests.map(request => [request.month, request.cutoffDate])) };
    await fs.writeFile(sourceFile, bytes, { flag: "wx", mode: 0o600 });
    await fs.writeFile(path.join(output, "provenance.json"), JSON.stringify(provenance), { flag: "wx", mode: 0o600 });
    const trustedTimes = [...source.observations.map(row => row.collectedAt), ...source.rankObservations.map(row => row.collectedAt), ...source.runs.filter(run => run.collectedAtSource !== "filesystem").map(run => run.collectedAt)].filter(value => Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(a) - Date.parse(b));
    const result = { schemaVersion: 1, state: "complete", currentRequest: current, normalizationRequests: requests, sourceFile, sourceSha256: sha(bytes), sourceBytes: bytes.length,
      counts: Object.fromEntries(["companies", "runs", "observations", "rankObservations", "savedProductRecoveries"].map(key => [key, source[key].length])), captureManifestSha256: captured.sha256,
      sourceInventorySha256: capture.sourceInventorySha256, copiedAt: capture.capturedAt, snapshotCapturedAt: capture.capturedAt, latestTrustedObservationAt: trustedTimes.at(-1) || null,
      dataThrough: capture.capturedAt, dataThroughBasis: "saved_namespace_capture_time; individual observation/run timestamps are separate", isolation, removedFields: removed, records,
      captureMode: capture.captureMode, originalOutputVerification, observationIndexMode: "exact_application_streaming_fallback", scratch: scratch.status(),
      copyInputsBefore: before, immutableCopyInputsAfter: after, sourceWrites: 0, operatingMutations: 0, appEntryExecutions: 0, providerFactories: 0,
      guardMetrics: guards.metrics, sourceMetrics: wiring.metrics, sourceReadMetrics: wiring.sources.sourceReadMetrics(), bindings: wiring.bindings, memory: process.memoryUsage(), resourceUsage: process.resourceUsage(), elapsedMs: Date.now() - started };
    await fs.writeFile(path.join(output, "reconstruction-complete.json"), JSON.stringify(result), { flag: "wx", mode: 0o600 });
    return { state: "complete", sourceFile, sourceSha256: result.sourceSha256, sourceBytes: result.sourceBytes, counts: result.counts, copiedAt: result.copiedAt,
      normalizationCutoffs: provenance.normalizationCutoffs, sourceWrites: 0, operatingMutations: 0, providerCalls: 0, appEntryExecutions: 0, elapsedMs: result.elapsedMs };
  } catch (error) {
    try { await fs.writeFile(path.join(output, "reconstruction-failed.json"), JSON.stringify({ state: "failed", code: error.code || "KEYWORD_RECONSTRUCT_FAILED", sourceWrites: 0, partialFilesRetained: true }), { flag: "wx", mode: 0o600 }); } catch {}
    throw error;
  } finally { scratch.restore(); outputs.restore(); guards.restore(); }
}
if (require.main === module) run(process.argv.slice(2)).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(JSON.stringify({ code: error.code || "KEYWORD_RECONSTRUCT_FAILED" })); process.exitCode = 1; });
module.exports = { args, kernelIsolation, installGuards, publicSource, snapshotCore, verifyCopyInputs, run };
