"use strict";

// Explicit offline acceptance command, deliberately outside default CI:
// node --expose-gc --max-old-space-size=512 scripts/test_keyword_monthly_workspace_realcopy.cjs --run-realcopy
// Only already-published normalized projections are read. No raw output rows,
// source JSONL, app server, queue, provider or collection entry point is loaded.
const fs = require("node:fs"), fsp = fs.promises, path = require("node:path"), crypto = require("node:crypto");
const vm = require("node:vm"), child = require("node:child_process");
const REPO = path.resolve(__dirname, ".."), BASE = "c29bf467";
const COPY_ROOT = "C:/Users/User/.codex/visualizations/2026/10/30/staydatalab-monthly-keyword-realcopy-20261030/round2-20261030";
const ARTIFACT_ROOT = "C:/Users/User/.codex/visualizations/2026/11/15/staydatalab-monthly-ui-state-20261115";
const BOUNDS = Object.freeze({ indexBytes: 1024 ** 2, projectionBytes: 32 * 1024 ** 2, totalProjectionBytes: 128 * 1024 ** 2,
  sourceFileBytes: 2 * 1024 ** 2, sourceFiles: 48, totalSourceBytes: 12 * 1024 ** 2, receiptBytes: 2 * 1024 ** 2, companyCount: 1000 });
const UI_FILES = ["web/keyword-monthly-benchmark.js", "web/keyword-monthly-dashboard-model.js", "web/keyword-monthly-analysis.js"];
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const fault = code => Object.assign(new Error(code), { code });
const requireThat = (condition, code) => { if (!condition) throw fault(code); };
const within = (root, value) => { const relative = path.relative(root, value); return relative === "" || !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative); };
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink].join("|");

async function safePath(file, directory) {
  const absolute = path.resolve(file), parsed = path.parse(absolute); let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const stat = await fsp.lstat(current);
    requireThat(!stat.isSymbolicLink() && path.relative(await fsp.realpath(current), current) === "", "REALCOPY_UNSAFE_PATH");
    if (current !== absolute) requireThat(stat.isDirectory(), "REALCOPY_UNSAFE_PARENT");
  }
  const stat = await fsp.lstat(absolute);
  requireThat(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, "REALCOPY_UNSAFE_FILE");
  return stat;
}

async function read(file, maximum) {
  const before = await safePath(file, false);
  requireThat(before.size > 0 && before.size <= maximum, "REALCOPY_READ_BOUND");
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    requireThat(stamp(before) === stamp(await handle.stat()), "REALCOPY_EVIDENCE_CHANGED");
    const bytes = Buffer.alloc(before.size + 1); let size = 0;
    while (size < bytes.length) { const next = await handle.read(bytes, size, bytes.length - size, size); if (!next.bytesRead) break; size += next.bytesRead; }
    requireThat(size === before.size && stamp(before) === stamp(await handle.stat()) && stamp(before) === stamp(await safePath(file, false)), "REALCOPY_EVIDENCE_CHANGED");
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

async function projectionManifest(directory) {
  await safePath(directory, true);
  const indexFile = path.join(directory, "index.json"), bytes = await read(indexFile, BOUNDS.indexBytes);
  const index = JSON.parse(bytes.toString("utf8"));
  requireThat(index.schemaVersion === 1 && index.provenance?.basis === "explicit_offline_normalized_source_copy"
    && index.provenance.observationScope === "normalized_multirun" && index.provenance.networkAttempted === false
    && index.provenance.contextIncluded === false && Number.isFinite(Date.parse(index.provenance.materializedAt)), "REALCOPY_COMPLETE_NORMALIZED_INDEX_REQUIRED");
  const files = [{ absolutePath: indexFile, bytes: bytes.length, sha256: sha(bytes) }], seen = new Set(); let total = bytes.length;
  for (const keyword of index.keywords || []) for (const scope of keyword.scopes || []) {
    requireThat(/^[a-f0-9]{64}$/.test(scope.scopeKey || "") && /^[a-f0-9]{64}$/.test(scope.sha256 || "")
      && [undefined, "gzip"].includes(scope.encoding), "REALCOPY_SCOPE_INVALID");
    const file = path.join(directory, "projections", scope.scopeKey + ".json" + (scope.encoding === "gzip" ? ".gz" : ""));
    if (seen.has(file)) continue; seen.add(file);
    requireThat(seen.size <= 4, "REALCOPY_SCOPE_BOUND");
    const contents = await read(file, BOUNDS.projectionBytes); total += contents.length;
    requireThat(total <= BOUNDS.totalProjectionBytes && contents.length === scope.bytes && sha(contents) === scope.sha256, "REALCOPY_PROJECTION_HASH_OR_BOUND");
    files.push({ absolutePath: file, bytes: contents.length, sha256: sha(contents) });
  }
  requireThat(files.length === 3, "REALCOPY_TWO_MONTH_PROJECTIONS_REQUIRED");
  return { directory, index, files, totalBytes: total };
}

async function sourceGraph(entries) {
  const files = new Map(); let totalBytes = 0;
  async function visit(relative) {
    const file = path.resolve(REPO, relative);
    const moduleFile = /\.(?:js|cjs)$/.test(file) || path.relative(REPO, file).replaceAll(path.sep, "/") === "scripts/verified_room_inventory.json";
    requireThat(within(REPO, file) && moduleFile && !/(?:^|[\\/])(?:kosis|collector|glamping_app_server)/i.test(file), "REALCOPY_NON_PURE_DEPENDENCY_DENIED:" + path.relative(REPO, file));
    if (files.has(file)) return;
    requireThat(files.size < BOUNDS.sourceFiles, "REALCOPY_SOURCE_COUNT_BOUND");
    const bytes = await read(file, BOUNDS.sourceFileBytes); totalBytes += bytes.length;
    requireThat(totalBytes <= BOUNDS.totalSourceBytes, "REALCOPY_SOURCE_BYTES_BOUND");
    files.set(file, { absolutePath: file, bytes: bytes.length, sha256: sha(bytes), text: bytes.toString("utf8") });
    for (const match of bytes.toString("utf8").matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
      if (!match[1].startsWith(".")) { requireThat(match[1].startsWith("node:"), "REALCOPY_EXTERNAL_MODULE_DENIED"); continue; }
      let next = path.resolve(path.dirname(file), match[1]); if (!path.extname(next)) next += ".cjs";
      await visit(path.relative(REPO, next));
    }
  }
  for (const file of entries) await visit(file);
  return files;
}

function guards() {
  const counters = { writeAttempts: 0, networkAttempts: 0, childAttemptsAfterBaselineRead: 0, timerAttempts: 0 }, restores = [];
  const patch = (object, key, next) => { if (typeof object[key] !== "function") return; const old = object[key]; object[key] = next; restores.push(() => { object[key] = old; }); };
  const deny = counter => () => { counters[counter]++; throw fault("REALCOPY_SIDE_EFFECT_DENIED"); };
  for (const object of [fs, fsp]) {
    for (const key of ["writeFile", "appendFile", "mkdir", "mkdtemp", "rename", "copyFile", "cp", "rm", "rmdir", "unlink", "truncate", "chmod", "chown", "utimes", "link", "symlink"]) {
      patch(object, key, deny("writeAttempts")); patch(object, key + "Sync", deny("writeAttempts"));
    }
    for (const key of ["open", "openSync"]) {
      const old = object[key]; if (typeof old !== "function") continue;
      patch(object, key, function (file, flags, ...rest) {
        if (typeof flags === "number" ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC)) : !["r", "rs"].includes(flags)) return deny("writeAttempts")();
        return old.call(this, file, flags, ...rest);
      });
    }
  }
  patch(fs, "createWriteStream", deny("writeAttempts"));
  patch(globalThis, "fetch", deny("networkAttempts")); patch(globalThis, "WebSocket", deny("networkAttempts"));
  for (const name of ["node:http", "node:https"]) for (const key of ["request", "get", "createServer"]) patch(require(name), key, deny("networkAttempts"));
  const net = require("node:net"); for (const key of ["connect", "createConnection", "createServer"]) patch(net, key, deny("networkAttempts")); patch(net.Socket.prototype, "connect", deny("networkAttempts"));
  patch(require("node:tls"), "connect", deny("networkAttempts")); patch(require("node:http2"), "connect", deny("networkAttempts"));
  const dgram = require("node:dgram"); for (const key of ["connect", "send"]) patch(dgram.Socket.prototype, key, deny("networkAttempts"));
  const dns = require("node:dns"); for (const key of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]) { patch(dns, key, deny("networkAttempts")); if (dns.promises) patch(dns.promises, key, deny("networkAttempts")); }
  for (const key of ["exec", "execFile", "spawn", "fork", "execSync", "execFileSync", "spawnSync"]) patch(child, key, deny("childAttemptsAfterBaselineRead"));
  for (const key of ["setTimeout", "setInterval"]) patch(globalThis, key, deny("timerAttempts"));
  return { counters, restore() { for (const restore of restores.reverse()) restore(); } };
}

function loadPure(sources, helper) {
  const loaded = new Map();
  if (helper) loaded.set("./admin-view-state.js", helper);
  for (const relative of UI_FILES) {
    const name = "./" + path.basename(relative), module = { exports: {} };
    const context = vm.createContext({ module, exports: module.exports, require(key) {
      requireThat(loaded.has(key), "REALCOPY_UI_DEPENDENCY_DENIED"); return loaded.get(key);
    } });
    new vm.Script(sources.get(relative), { filename: relative }).runInContext(context, { timeout: 5000 });
    loaded.set(name, module.exports);
  }
  return { ui: loaded.get("./keyword-monthly-analysis.js"), benchmark: loaded.get("./keyword-monthly-benchmark.js").buildKeywordMonthlyBenchmark,
    dashboard: loaded.get("./keyword-monthly-dashboard-model.js").buildKeywordMonthlyDashboardModel };
}

function deepFreeze(value, seen = new Set()) {
  if (value && typeof value === "object" && !seen.has(value)) { seen.add(value); Object.values(value).forEach(child => deepFreeze(child, seen)); Object.freeze(value); }
  return value;
}

function digestValue(value) {
  const hash = crypto.createHash("sha256");
  function walk(value) {
    if (value === null) { hash.update("null;"); return; }
    if (typeof value !== "object") { hash.update(`${typeof value}:${String(value)};`); return; }
    if (Array.isArray(value)) { hash.update("["); for (const entry of value) walk(entry); hash.update("]"); return; }
    hash.update("{"); for (const key of Object.keys(value).sort()) { hash.update(JSON.stringify(key) + ":"); walk(value[key]); } hash.update("}");
  }
  walk(value); return hash.digest("hex");
}

function compare(before, after, label) {
  const counts = { numericLeaves: 0, nullLeaves: 0, otherLeaves: 0, objects: 0, arrays: 0 };
  function walk(a, b, field) {
    requireThat(typeof a === typeof b && Array.isArray(a) === Array.isArray(b), "REALCOPY_MODEL_TYPE_CHANGED:" + field);
    if (a === null || b === null) { requireThat(a === b, "REALCOPY_NULL_CHANGED:" + field); counts.nullLeaves++; return; }
    if (typeof a !== "object") { requireThat(Object.is(a, b), "REALCOPY_VALUE_CHANGED:" + field); counts[typeof a === "number" ? "numericLeaves" : "otherLeaves"]++; return; }
    if (Array.isArray(a)) { counts.arrays++; requireThat(a.length === b.length, "REALCOPY_ARRAY_CHANGED:" + field); for (let index = 0; index < a.length; index++) walk(a[index], b[index], field + "[" + index + "]"); return; }
    counts.objects++; const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
    requireThat(ak.length === bk.length && ak.every((key, index) => key === bk[index]), "REALCOPY_FIELDS_CHANGED:" + field);
    for (const key of ak) walk(a[key], b[key], field + "." + key);
  }
  walk(before, after, label);
  return { ...counts, beforeDigest: digestValue(before), afterDigest: digestValue(after), equal: true };
}

function assertTotals(model) {
  const known = model.companies.filter(company => company.observedCompanyDays > 0), whole = model.monthly.whole;
  const sum = key => known.length ? known.reduce((value, company) => value + company[key], 0) : null;
  requireThat(sum("supply") === whole.supply && sum("sold") === whole.sold, "REALCOPY_COMPANY_WHOLE_QUANTITY_MISMATCH");
  requireThat(whole.totalRate === (whole.supply > 0 ? whole.sold / whole.supply : null), "REALCOPY_RATE_DENOMINATOR_MISMATCH");
  requireThat(model.monthly.rosterCompanyCount === model.companies.length, "REALCOPY_ROSTER_TRUNCATED");
}

function comparisonReceipt(value) {
  if (value === null) return null;
  const { previousSources, ...summary } = value;
  // Full previousSources participated in the structural comparison above. Keep
  // only its digest/counts in the receipt, never duplicate source observations.
  return { ...summary, previousSources: previousSources ? { structuralDigest: digestValue(previousSources),
    observations: previousSources.observations?.length ?? null, partialEvidence: previousSources.partialEvidence?.length ?? null,
    runIds: previousSources.runIds || [], selectedObservationCount: previousSources.selectedObservationCount ?? null,
    discardedObservationCount: previousSources.discardedObservationCount ?? null } : null };
}

async function run(argv = process.argv.slice(2)) {
  if (!argv.includes("--run-realcopy")) { console.log("SKIP: explicit --run-realcopy required; no real-data reads in default CI."); return null; }
  const options = { receipt: path.join(ARTIFACT_ROOT, "offline-realcopy-verification-v1.json") };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--run-realcopy") continue;
    requireThat(argv[index] === "--receipt" && argv[index + 1], "REALCOPY_ARGUMENT_INVALID"); options.receipt = path.resolve(argv[++index]);
  }
  requireThat(within(path.resolve(ARTIFACT_ROOT), options.receipt) && /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(path.basename(options.receipt)), "REALCOPY_RECEIPT_PATH_DENIED");
  await fsp.mkdir(path.dirname(options.receipt), { recursive: true }); await safePath(path.dirname(options.receipt), true);
  try { await fsp.lstat(options.receipt); throw fault("REALCOPY_RECEIPT_EXISTS"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const baseCommit = child.execFileSync("git", ["rev-parse", BASE], { cwd: REPO, maxBuffer: 4096 }).toString().trim();
  requireThat(/^[a-f0-9]{40}$/.test(baseCommit), "REALCOPY_BASE_COMMIT_INVALID");
  const baselineSources = new Map(UI_FILES.map(file => [file, child.execFileSync("git", ["show", `${baseCommit}:${file}`], { cwd: REPO, maxBuffer: BOUNDS.sourceFileBytes }).toString("utf8")]));
  const copies = [];
  for (const [name, keyword] of [["acceptance-gapyeong-v2", "가평글램핑"], ["acceptance-gyeongnam-v3", "경남글램핑"]]) {
    const manifest = await projectionManifest(path.join(COPY_ROOT, name, "projection-complete-source"));
    requireThat(manifest.index.keywords.length === 1 && manifest.index.keywords[0].keyword === keyword, "REALCOPY_KEYWORD_MISMATCH"); copies.push(manifest);
  }
  const currentFiles = await sourceGraph([...UI_FILES, "web/admin-view-state.js", "scripts/lib/keyword_monthly_analysis.cjs"]);
  const currentSources = new Map(UI_FILES.map(file => [file, currentFiles.get(path.join(REPO, file)).text]));
  const startedAt = new Date().toISOString(), guard = guards(), cases = []; let readsVerified = false;
  try {
    const helper = require("../web/admin-view-state.js"), before = loadPure(baselineSources, helper), after = loadPure(currentSources, helper);
    const { createKeywordMonthlyAnalysis } = require("./lib/keyword_monthly_analysis.cjs");
    for (const copy of copies) {
      const clock = new Date(Date.parse(copy.index.provenance.materializedAt) + 1000).toISOString();
      const service = createKeywordMonthlyAnalysis({ projectionDir: copy.directory, now: () => new Date(clock) });
      const catalog = await service.options(); requireThat(catalog.status === "available", "REALCOPY_OPTIONS_NOT_AVAILABLE");
      for (const keyword of catalog.keywords) for (const month of keyword.stayMonths) {
        const selection = { keyword: keyword.keyword, month, cutoffDate: keyword.defaultCutoffs[month] };
        const payload = deepFreeze(await service.analyze(selection)); requireThat(payload.status === "available" && payload.snapshot, "REALCOPY_ANALYSIS_NOT_AVAILABLE");
        const payloadDigest = digestValue(payload), previousView = before.ui.buildViewModel(payload, selection, catalog.currentMonth), currentView = after.ui.buildViewModel(payload, selection, catalog.currentMonth);
        requireThat(previousView.usable && currentView.usable, "REALCOPY_UI_NOT_USABLE");
        const uiComparison = compare(previousView, currentView, "buildViewModel"), products = [];
        for (const productType of ["lodging", "dayuse"]) {
          const opts = { productType }, b = before.benchmark(payload.snapshot, opts), a = after.benchmark(payload.snapshot, opts);
          const bd = before.dashboard(payload.snapshot, opts), ad = after.dashboard(payload.snapshot, opts);
          requireThat(![b, a, bd, ad].some(value => value.status === "needs_verification"), "REALCOPY_MODEL_NEEDS_VERIFICATION");
          const benchmarkComparison = compare(b, a, "benchmark"), dashboardComparison = compare(bd, ad, "dashboard"); assertTotals(ad);
          const companyIds = [...new Set([...payload.snapshot.companies, ...b.companies, ...a.companies, ...bd.companies, ...ad.companies].map(row => row.companyId))];
          requireThat(companyIds.length > 0 && companyIds.length <= BOUNDS.companyCount && companyIds.every(id => typeof id === "string" && id), "REALCOPY_COMPANY_ID_INVALID");
          requireThat(companyIds.length === payload.snapshot.companies.length && companyIds.length === ad.companies.length, "REALCOPY_COMPANY_UNION_TRUNCATED");
          const allCompanyChecks = [];
          for (const companyId of companyIds) {
            const chosen = { productType, companyId }, oldBenchmark = before.benchmark(payload.snapshot, chosen), newBenchmark = after.benchmark(payload.snapshot, chosen);
            const oldDashboard = before.dashboard(payload.snapshot, chosen), newDashboard = after.dashboard(payload.snapshot, chosen);
            requireThat([oldBenchmark, newBenchmark, oldDashboard, newDashboard].every(value => value.selectedCompanyId === companyId), "REALCOPY_SELECTION_SUBSTITUTED");
            assertTotals(newDashboard);
            allCompanyChecks.push({ companyId, benchmark: compare(oldBenchmark, newBenchmark, "companyBenchmark"), dashboard: compare(oldDashboard, newDashboard, "companyDashboard") });
          }
          products.push({ productType, status: ad.status, companyCount: companyIds.length, companyIds, benchmarkComparison, dashboardComparison,
            summary: currentView.summary[productType], monthly: ad.monthly, daily: ad.daily, fairDaily: ad.fairDaily,
            previousMonthComparison: comparisonReceipt(currentView.comparisons[productType]), allCompanyChecks, allCompanyUnionVerified: true });
        }
        requireThat(digestValue(payload) === payloadDigest, "REALCOPY_INPUT_MUTATED");
        cases.push({ selection, referenceClock: clock, status: "verified", projectionSha256: payload.provenance.projectionSha256,
          sourceDigest: payload.provenance.sourceDigest, inputPreserved: true, uiComparison, products });
        console.log(JSON.stringify({ checked: selection, products: products.map(row => ({ productType: row.productType, companies: row.companyCount, status: row.status })) }));
        if (global.gc) global.gc();
      }
    }
    for (const copy of copies) for (const file of copy.files) requireThat(sha(await read(file.absolutePath, file.absolutePath.endsWith("index.json") ? BOUNDS.indexBytes : BOUNDS.projectionBytes)) === file.sha256, "REALCOPY_SOURCE_CHANGED");
    for (const file of currentFiles.values()) requireThat(sha(await read(file.absolutePath, BOUNDS.sourceFileBytes)) === file.sha256, "REALCOPY_IMPLEMENTATION_CHANGED_DURING_READ:" + path.relative(REPO, file.absolutePath));
    requireThat(Object.values(guard.counters).every(value => value === 0), "REALCOPY_SIDE_EFFECT_ATTEMPTED"); readsVerified = true;
  } finally { guard.restore(); }
  requireThat(readsVerified && cases.length === 4, "REALCOPY_INCOMPLETE_VERIFICATION");
  const products = cases.flatMap(value => value.products);
  const coverageAssertions = {
    fourKeywordMonthScopes: cases.length === 4,
    eightProductScopes: products.length === 8,
    everyRosterCompanySelectedAndCompared: products.every(value => value.allCompanyUnionVerified && value.companyCount === value.allCompanyChecks.length),
    positiveSeparatePartialMoneyCovered: products.some(value => value.summary.knownPartialRevenue > 0),
    priorMonthComparisonCovered: products.some(value => value.previousMonthComparison !== null),
    unobservedNullRateCovered: products.some(value => value.monthly.selected?.totalRate === null || value.daily.some(day => day.wholeRate === null)),
    observedZeroRateCovered: products.some(value => value.daily.some(day => day.wholeObserved && day.wholeRate === 0 || day.selectedObserved && day.selectedRate === 0))
  };
  requireThat(Object.values(coverageAssertions).every(Boolean), "REALCOPY_CORPUS_COVERAGE_INSUFFICIENT");
  const receipt = { schemaVersion: 1, status: "verified_offline_realcopy_ui_preservation", startedAt, finishedAt: new Date().toISOString(), baseCommit,
    productionVerified: false, operationalChanges: false, providerCalls: 0, rawOriginalRowsRead: 0,
    method: "Same issued normalized projection payload through pinned-base and current pure UI/benchmark/dashboard modules. Full structural, numeric and null comparison for every roster company selection; array order retained and object keys normalized.",
    scopeCount: cases.length, productScopeCount: cases.reduce((sum, value) => sum + value.products.length, 0),
    allCompanySelectionsChecked: cases.reduce((sum, value) => sum + value.products.reduce((n, product) => n + product.companyCount, 0), 0),
    projectedSources: copies.map(copy => ({ directory: copy.directory, provenance: copy.index.provenance, totalBytes: copy.totalBytes, files: copy.files, preserved: true })),
    baselineUiSources: [...baselineSources].map(([relativePath, source]) => ({ relativePath, sha256: sha(source), origin: `git show ${baseCommit}:${relativePath}` })),
    currentSources: [...currentFiles.values()].map(({ absolutePath, bytes, sha256 }) => ({ absolutePath, bytes, sha256, preserved: true })),
    sideEffectGuards: guard.counters, bounds: BOUNDS, coverageAssertions, cases,
    limitations: ["Offline frozen October22 normalized copies of September/October observations; not current production or full historical capture completeness.",
      "The existing saved-projection analysis engine computes the identical payload for both UI versions. This checks UI arithmetic/denominator/null/partial-money/common-sample preservation, not an independent audit of all original source rows.",
      "Historical clock is pinned to projection materialization plus one second solely for the offline saved-reader freshness contract.",
      "No browser layout, administrator authentication, new collection, automatic publication, scheduler protection, account remaining quota or KOSIS verification is performed."] };
  const contents = Buffer.from(JSON.stringify(receipt, null, 2) + "\n"); requireThat(contents.length <= BOUNDS.receiptBytes, "REALCOPY_RECEIPT_BOUND");
  await safePath(path.dirname(options.receipt), true);
  const handle = await fsp.open(options.receipt, "wx", 0o600);
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
  const saved = await read(options.receipt, BOUNDS.receiptBytes); requireThat(saved.equals(contents), "REALCOPY_RECEIPT_READBACK_FAILED");
  console.log(JSON.stringify({ status: receipt.status, receipt: options.receipt, bytes: contents.length, sha256: sha(contents), scopes: receipt.scopeCount,
    products: receipt.productScopeCount, companies: receipt.allCompanySelectionsChecked })); return receipt;
}

if (require.main === module) run().catch(error => { console.error(error.code || error.message || "REALCOPY_VERIFICATION_FAILED"); process.exitCode = 1; });
module.exports = { run, BOUNDS };
