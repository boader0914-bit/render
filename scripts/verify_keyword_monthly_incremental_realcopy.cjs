"use strict";

// Explicit offline verification only. No application, collector or provider is
// imported. Existing capture manifests are the complete read allowlist; this
// tool never discovers files by walking the saved source directory.
const fs = require("node:fs/promises");
const native = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const SHA = /^[a-f0-9]{64}$/;
const MAX = Object.freeze({ json: 64 * 1024 * 1024, manifest: 16 * 1024 * 1024,
  history: 512 * 1024 * 1024, line: 16 * 1024 * 1024, scratch: 1024 * 1024 * 1024 });
const ARRAYS = ["companies", "runs", "observations", "rankObservations", "savedProductRecoveries"];
const PRODUCTS = ["lodging", "dayuse"];
const LIMITATIONS = [
  "Frozen saved-copy replay only; no current production, collection freshness or complete calendar-month claim.",
  "Company master, manual reviews, capacity registry and calendar remain at the frozen latest state in every physical prefix. Historical metadata state is not reconstructed.",
  "Physical replay retains the selected keyword's recorded run history in original byte/line order and selected saved outputs. Other-keyword history is outside this bounded fixture.",
  "A split of already-normalized rows proves Layer A only. Layer B requires independent full normalization of the physical before/after fixtures and actual delta normalization.",
  "Unobserved recovery, failure and dependency-drift events require separately labelled synthetic tests; they cannot be inferred from this saved copy."
];
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function need(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }
function inside(root, file) { const r = path.relative(root, file); return r === "" || r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r); }
function absolute(file) { need(typeof file === "string" && path.isAbsolute(file) && path.resolve(file) === file, "INCREMENTAL_VERIFY_ABSOLUTE_PATH"); return file; }
function relative(value) { need(typeof value === "string" && value && !path.isAbsolute(value) && !value.split(/[\\/]/).some(p => !p || p === "." || p === ".."), "INCREMENTAL_VERIFY_RELATIVE_PATH"); return value; }
function stamp(s) { return Object.fromEntries(["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode", "nlink"].map(k => [k, String(s[k])])); }
function same(a, b) { return JSON.stringify(stamp(a)) === JSON.stringify(stamp(b)); }
async function checked(file, directory = false) {
  absolute(file); let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const s = await fs.lstat(current, { bigint: true });
    need(!s.isSymbolicLink() && (current === file || s.isDirectory()), "INCREMENTAL_VERIFY_SYMLINK");
  }
  const s = await fs.lstat(file, { bigint: true });
  need(directory ? s.isDirectory() : s.isFile() && s.nlink === 1n, "INCREMENTAL_VERIFY_FILE_TYPE");
  need(await fs.realpath(file) === file, "INCREMENTAL_VERIFY_REALPATH"); return s;
}
async function readJson(file, maximum = MAX.json) {
  const before = await checked(file); need(before.size <= BigInt(maximum), "INCREMENTAL_VERIFY_SIZE_BOUND");
  const fd = await fs.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0));
  let bytes;
  try { need(same(before, await fd.stat({ bigint: true })), "INCREMENTAL_VERIFY_INPUT_CHANGED"); bytes = await fd.readFile();
    need(bytes.length === Number(before.size) && same(before, await fd.stat({ bigint: true })), "INCREMENTAL_VERIFY_INPUT_CHANGED");
  } finally { await fd.close(); }
  need(same(before, await checked(file)), "INCREMENTAL_VERIFY_INPUT_CHANGED");
  return { file, bytes: bytes.length, sha256: hash(bytes), value: JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")), stat: stamp(before) };
}
async function fileDigest(file, maximum = MAX.history) {
  const before = await checked(file); need(before.size <= BigInt(maximum), "INCREMENTAL_VERIFY_SIZE_BOUND");
  const fd = await fs.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0)), h = crypto.createHash("sha256");
  let bytes = 0;
  try { need(same(before, await fd.stat({ bigint: true })), "INCREMENTAL_VERIFY_INPUT_CHANGED");
    for await (const chunk of fd.createReadStream({ autoClose: false })) { bytes += chunk.length; need(bytes <= maximum, "INCREMENTAL_VERIFY_SIZE_BOUND"); h.update(chunk); }
    need(bytes === Number(before.size) && same(before, await fd.stat({ bigint: true })), "INCREMENTAL_VERIFY_INPUT_CHANGED");
  } finally { await fd.close(); }
  need(same(before, await checked(file)), "INCREMENTAL_VERIFY_INPUT_CHANGED"); return { file, bytes, sha256: h.digest("hex"), stat: stamp(before) };
}
// Explicit type tagging prevents undefined/null/zero from silently colliding.
function canonical(value) {
  if (value === undefined) return ["undefined"];
  if (value === null) return ["null"];
  if (Array.isArray(value)) return ["array", value.map(canonical)];
  if (typeof value === "object") return ["object", Object.keys(value).sort().map(k => [k, canonical(value[k])])];
  if (typeof value === "number") return ["number", Number.isFinite(value) ? Object.is(value, -0) ? "-0" : value : String(value)];
  return [typeof value, value];
}
const fingerprint = value => hash(JSON.stringify(canonical(value)));
const multiset = rows => fingerprint(rows.map(fingerprint).sort());
const companyId = row => String(row.companyId || row.companyKey || row.id || "");
const runId = row => String(row.id || row.runId || "");
const quality = row => String(typeof row.collectionQuality === "string" ? row.collectionQuality : row.collectionQuality?.status || "unknown");
const rowKey = row => JSON.stringify([companyId(row), row.date || row.stayDate || "", row.productType === "day-use" ? "dayuse" : row.productType || ""]);
function nullZeroShape(value, out = { null: 0, undefined: 0, zero: 0, finiteNumber: 0, string: 0, boolean: 0, array: 0, object: 0 }) {
  if (value === null) out.null++; else if (value === undefined) out.undefined++;
  else if (typeof value === "number") { if (value === 0) out.zero++; if (Number.isFinite(value)) out.finiteNumber++; }
  else if (typeof value === "string") out.string++; else if (typeof value === "boolean") out.boolean++;
  else if (typeof value === "object") { out[Array.isArray(value) ? "array" : "object"]++; for (const v of Object.values(value)) nullZeroShape(v, out); }
  return out;
}
function sourceSummary(source) {
  need(source && ARRAYS.every(k => Array.isArray(source[k] || [])), "INCREMENTAL_VERIFY_SOURCE_SHAPE");
  return { arrays: Object.fromEntries(ARRAYS.map(k => { const rows = source[k] || []; return [k, { rows: rows.length, orderedSha256: fingerprint(rows), multisetSha256: multiset(rows) }]; })),
    metadataSha256: fingerprint(Object.fromEntries(Object.entries(source).filter(([k]) => !ARRAYS.includes(k)))),
    companyIdsSha256: fingerprint((source.companies || []).map(companyId)), nullZeroShape: nullZeroShape(source) };
}
function compareNormalizedSources(actual, expected) {
  const a = sourceSummary(actual), e = sourceSummary(expected), checks = [];
  for (const k of ARRAYS) checks.push({ name: `source:${k}`, passed: fingerprint(a.arrays[k]) === fingerprint(e.arrays[k]), actual: a.arrays[k], expected: e.arrays[k] });
  for (const k of ["metadataSha256", "companyIdsSha256", "nullZeroShape"]) checks.push({ name: `source:${k}`, passed: fingerprint(a[k]) === fingerprint(e[k]) });
  return { passed: checks.every(c => c.passed), checks };
}
function partialAccounting(snapshot) {
  const normal = snapshot.sources?.observations || [], partial = snapshot.sources?.partialEvidence || [], included = partial.filter(r => r.includedInPartialSubtotal === true);
  const normalKeys = normal.map(rowKey), partialKeys = included.map(rowKey), failures = [];
  if (new Set(normalKeys).size !== normalKeys.length) failures.push("duplicate_normal_key");
  if (new Set(partialKeys).size !== partialKeys.length) failures.push("duplicate_partial_key");
  const normalSet = new Set(normalKeys); if (partialKeys.some(k => normalSet.has(k))) failures.push("normal_partial_overlap");
  function verify(metric, rows, label) {
    const fields = ["knownPartialRevenue", "knownPartialPublicRevenue", "knownPartialBlockedRevenue"];
    for (const key of fields) { const n = rows.length ? rows.reduce((sum, r) => sum + (typeof r[key] === "number" && Number.isFinite(r[key]) ? r[key] : 0), 0) : null;
      if (rows.some(r => typeof r[key] !== "number" || !Number.isFinite(r[key])) || metric?.[key] !== n) failures.push(`${label}:${key}`); }
    if (metric?.knownPartialCompanyDays !== rows.length) failures.push(`${label}:knownPartialCompanyDays`);
  }
  for (const product of PRODUCTS) {
    const rows = included.filter(r => r.productType === product); verify(snapshot.summary?.[product], rows, `summary:${product}`);
    for (const day of snapshot.daily || []) verify(day[product], rows.filter(r => r.date === day.date), `daily:${product}`);
    for (const company of snapshot.companies || []) { const own = rows.filter(r => companyId(r) === companyId(company)); verify(company.summary?.[product], own, `company:${product}`);
      for (const day of company.daily || []) verify(day[product], own.filter(r => r.date === day.date), `company_daily:${product}`); }
  }
  return { passed: failures.length === 0, normalRows: normal.length, partialRows: partial.length, includedPartialRows: included.length,
    normalKeysSha256: multiset(normalKeys), partialKeysSha256: multiset(partial.map(rowKey)), includedPartialSha256: multiset(included),
    failureCount: failures.length, failures: [...new Set(failures)].slice(0, 100), failuresTruncated: new Set(failures).size > 100 };
}
function compareSnapshots(actual, expected) {
  need(actual && expected, "INCREMENTAL_VERIFY_SNAPSHOT_REQUIRED");
  const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
  const checks = keys.map(key => ({ name: `snapshot:${key}`, passed: fingerprint(actual[key]) === fingerprint(expected[key]), actualSha256: fingerprint(actual[key]), expectedSha256: fingerprint(expected[key]) }));
  const a = partialAccounting(actual), e = partialAccounting(expected);
  checks.push({ name: "partial_accounting_and_suppression", passed: a.passed && e.passed && fingerprint(a) === fingerprint(e) });
  checks.push({ name: "null_zero_shape", passed: fingerprint(nullZeroShape(actual)) === fingerprint(nullZeroShape(expected)) });
  return { passed: checks.every(c => c.passed), checks, actualPartialAccounting: a, expectedPartialAccounting: e };
}
async function inspectOracles(files, keyword) {
  const summaries = [], map = new Map();
  for (const file of files) {
    const receipt = await readJson(file, MAX.manifest), r = receipt.value;
    need(r.state === "complete" && SHA.test(r.sourceSha256 || "") && typeof r.sourceFile === "string" && r.currentRequest?.targetId === keyword,
      "INCREMENTAL_VERIFY_ORACLE_RECEIPT");
    const source = await readJson(absolute(r.sourceFile)); need(source.sha256 === r.sourceSha256 && source.bytes === r.sourceBytes, "INCREMENTAL_VERIFY_ORACLE_SOURCE_CHANGED");
    for (const [ordinal, run] of (source.value.runs || []).entries()) {
      const id = runId(run); need(id && !/[\\/\u0000-\u001f]/.test(id), "INCREMENTAL_VERIFY_RUN_ID");
      const small = { runId: id, collectedAt: run.collectedAt || null, quality: quality(run), sourceRunOrdinal: ordinal + 1, keyword: String(run.keyword || "") };
      if (map.has(id)) need(fingerprint({ ...small, sourceRunOrdinal: 0 }) === fingerprint({ ...map.get(id), sourceRunOrdinal: 0 }), "INCREMENTAL_VERIFY_ORACLE_RUN_CONFLICT");
      else map.set(id, small);
    }
    summaries.push({ receiptFile: file, receiptSha256: receipt.sha256, sourceFile: source.file, sourceSha256: source.sha256, sourceBytes: source.bytes,
      requests: r.normalizationRequests, summary: sourceSummary(source.value), savedProductRecoveryEvents: (source.value.savedProductRecoveries || []).length });
  }
  need(summaries.length > 0 && map.size > 1, "INCREMENTAL_VERIFY_ORACLES_REQUIRED");
  return { summaries, runs: [...map.values()].filter(r => r.keyword === keyword) };
}
// Preserve exact bytes, original line endings, multiplicity and original ordinals.
async function scanHistory(file, ids, consume = null) {
  const before = await checked(file); need(before.size <= BigInt(MAX.history), "INCREMENTAL_VERIFY_HISTORY_BOUND");
  const fd = await fs.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0)), h = crypto.createHash("sha256"), selected = crypto.createHash("sha256");
  const perRun = new Map(); let pending = Buffer.alloc(0), offset = 0, ordinal = 0, bytes = 0, rows = 0, malformedLines = 0;
  async function line(raw) {
    ordinal++; const start = offset; offset += raw.length; let row;
    try { row = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, "")); } catch { if (raw.toString("utf8").trim()) malformedLines++; return; }
    const id = String(row?.runId || ""); if (!ids.has(id)) return;
    rows++; selected.update(raw); const r = perRun.get(id) || { rows: 0, bytes: 0, firstOrdinal: ordinal, lastOrdinal: ordinal };
    r.rows++; r.bytes += raw.length; r.lastOrdinal = ordinal; perRun.set(id, r);
    if (consume) await consume({ raw, runId: id, ordinal, offset: start, sha256: hash(raw) });
  }
  try {
    need(same(before, await fd.stat({ bigint: true })), "INCREMENTAL_VERIFY_INPUT_CHANGED");
    for await (const chunk of fd.createReadStream({ autoClose: false })) {
      bytes += chunk.length; need(bytes <= MAX.history, "INCREMENTAL_VERIFY_HISTORY_BOUND"); h.update(chunk); pending = Buffer.concat([pending, chunk]);
      let start = 0, end;
      while ((end = pending.indexOf(10, start)) !== -1) { need(end + 1 - start <= MAX.line, "INCREMENTAL_VERIFY_LINE_BOUND"); await line(pending.subarray(start, end + 1)); start = end + 1; }
      pending = pending.subarray(start); need(pending.length <= MAX.line, "INCREMENTAL_VERIFY_LINE_BOUND");
    }
    if (pending.length) await line(pending);
    need(bytes === Number(before.size) && same(before, await fd.stat({ bigint: true })), "INCREMENTAL_VERIFY_INPUT_CHANGED");
  } finally { await fd.close(); }
  need(same(before, await checked(file)), "INCREMENTAL_VERIFY_INPUT_CHANGED");
  return { file, bytes, sha256: h.digest("hex"), selectedRows: rows, selectedBytes: [...perRun.values()].reduce((n, r) => n + r.bytes, 0),
    selectedSha256: selected.digest("hex"), originalPhysicalLines: ordinal, malformedLines, perRun: Object.fromEntries(perRun), stat: stamp(before) };
}
function outputRows(capture, ids) {
  return capture.originalOutputs.files.filter(r => ids.has(relative(r.relative).split("/")[0]) && /\.(?:json|csv|md)$/i.test(r.relative)
    && !/(?:^|\/)(?:traffic_metrics|tourism[^/]*|kosis[^/]*)\./i.test(r.relative));
}
function replayPlan({ capture, captured, oracles, history, keyword, beforeCount }) {
  const runs = oracles.runs.map(r => ({ ...r, history: history.perRun[r.runId] || { rows: 0, bytes: 0, firstOrdinal: null, lastOrdinal: null } }))
    .sort((a, b) => (Date.parse(a.collectedAt) || 0) - (Date.parse(b.collectedAt) || 0) || a.sourceRunOrdinal - b.sourceRunOrdinal || a.runId.localeCompare(b.runId));
  need(runs.length > 1, "INCREMENTAL_VERIFY_RUN_PREFIX_REQUIRED");
  const eligible = runs.map((r, i) => ({ r, i })).filter(({ r }) => r.quality === "complete" && r.history.rows > 0);
  need(eligible.length > 0, "INCREMENTAL_VERIFY_COMPLETED_DELTA_REQUIRED");
  const boundary = beforeCount === undefined ? eligible.at(-1).i : beforeCount;
  need(Number.isSafeInteger(boundary) && boundary >= 1 && boundary < runs.length, "INCREMENTAL_VERIFY_PREFIX_BOUNDARY");
  const count = runs.length - boundary;
  const arm = (name, selected) => { const ids = new Set(selected.map(r => r.runId)), outputs = outputRows(capture, ids);
    const historyBytes = selected.reduce((n, r) => n + r.history.bytes, 0), nonHistory = capture.inputFiles.filter(r => r.relative !== "history/observations.jsonl").reduce((n, r) => n + r.bytes, 0);
    return { name, runIds: [...ids], runCount: ids.size, historyRows: selected.reduce((n, r) => n + r.history.rows, 0), historyBytes,
      outputFiles: outputs.length, outputBytes: outputs.reduce((n, r) => n + r.bytes, 0), physicalDatasetBytes: nonHistory + historyBytes + outputs.reduce((n, r) => n + r.bytes, 0) }; };
  const arms = { before: arm("before", runs.slice(0, boundary)), after: arm("after", runs), delta: arm("delta", runs.slice(boundary)) };
  const queries = oracles.summaries.map(r => r.requests.at(-1));
  return { schemaVersion: 1, kind: "keyword_monthly_incremental_physical_replay_plan", status: "prepared", layerBAccepted: false,
    keyword, capturedAt: capture.capturedAt, captureManifestFile: captured.file, captureManifestSha256: captured.sha256,
    sourceInventorySha256: capture.sourceInventorySha256, frozenCore: capture.inputFiles.map(r => ({ relative: r.relative, bytes: r.bytes, sha256: r.sha256 })),
    existingFullOracles: oracles.summaries, sourceHistory: history, runOrdering: "recorded_collection_time_then_source_run_ordinal; physical_history_order_never_changes",
    runs, bootstrapRunCount: boundary, deltaRunCount: count, arms, queries, fourConditions: queries.flatMap(q => PRODUCTS.map(productType => ({ month: q.month, cutoffDate: q.cutoffDate, productType }))),
    plannedSequences: ["canonical_run_prefix_each_step", "same_delta_twice", "delivery_reverse_with_original_ordinal", "late_older_run", "crash_before_and_after_state_commit", "crash_before_and_after_pointer_promotion", "dependency_drift_fail_closed"],
    maxOwnScratchBytes: MAX.scratch, combinedPhysicalDatasetBytes: Object.values(arms).reduce((n, a) => n + a.physicalDatasetBytes, 0),
    sourceWrites: 0, operatingMutations: 0, providerCalls: 0, appEntryExecutions: 0, kosisDataRead: false, limitations: LIMITATIONS };
}
async function preparePlan(options) {
  const captured = await readJson(absolute(options.captureManifest), MAX.manifest), c = captured.value;
  need(c.state === "complete" && c.physicalCopiesOnly === true && c.sourceWrites === 0 && Array.isArray(c.inputFiles)
    && c.inputFiles.length <= 1000 && Array.isArray(c.originalOutputs?.files), "INCREMENTAL_VERIFY_CAPTURE");
  need(!c.historyCompression && c.inputFiles.every(r => !r.compression), "INCREMENTAL_VERIFY_RAW_CAPTURE_REQUIRED");
  for (const row of c.inputFiles) {
    relative(row.relative); need(/^(?:company_master\/companies\.json|history\/observations\.jsonl|history\/special_days\/special-days-\d{4}\.json|company_integrated\/capacity-(?:bases|history-index)\.json)$/.test(row.relative), "INCREMENTAL_VERIFY_CORE_ALLOWLIST");
    const actual = await fileDigest(path.join(absolute(c.dataDir), ...row.relative.split("/"))); need(actual.bytes === row.bytes && actual.sha256 === row.sha256, "INCREMENTAL_VERIFY_CAPTURE_BYTES_CHANGED");
  }
  const oracles = await inspectOracles(options.oracleCompletes.map(absolute), options.keyword), ids = new Set(oracles.runs.map(r => r.runId));
  const history = await scanHistory(path.join(c.dataDir, "history/observations.jsonl"), ids);
  const plan = replayPlan({ capture: c, captured, oracles, history, keyword: options.keyword, beforeCount: options.beforeCount });
  return { plan, capture: c };
}
async function createOwnedOutput(output, inputs = []) {
  absolute(output); need(inputs.every(i => !inside(absolute(i), output) && !inside(output, i)), "INCREMENTAL_VERIFY_OUTPUT_OVERLAP");
  await checked(path.dirname(output), true); await fs.mkdir(output, { mode: 0o700 });
  const owner = { schemaVersion: 1, kind: "keyword_monthly_incremental_verification_owner", token: crypto.randomUUID(), root: output, createdAt: new Date().toISOString() };
  await fs.writeFile(path.join(output, "verification-owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 }); return owner;
}
async function writeNew(file, value) { await fs.writeFile(file, JSON.stringify(value), { flag: "wx", mode: 0o600 }); return file; }
async function copyExact(source, target, expected, maximum) {
  const before = await checked(source); need(before.size <= BigInt(maximum) && (!expected.stamp || JSON.stringify(stamp(before)) === JSON.stringify(expected.stamp)), "INCREMENTAL_VERIFY_COPY_CHANGED");
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const input = await fs.open(source, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0)), output = await fs.open(target, "wx", 0o600), h = crypto.createHash("sha256"); let bytes = 0;
  try { need(same(before, await input.stat({ bigint: true })), "INCREMENTAL_VERIFY_COPY_CHANGED");
    for await (const chunk of input.createReadStream({ autoClose: false })) { bytes += chunk.length; need(bytes <= maximum, "INCREMENTAL_VERIFY_COPY_BOUND"); h.update(chunk); await output.writeFile(chunk); }
    await output.sync(); need(same(before, await input.stat({ bigint: true })) && same(before, await checked(source)), "INCREMENTAL_VERIFY_COPY_CHANGED");
  } finally { await input.close(); await output.close(); }
  const sha256 = h.digest("hex"); need(bytes === expected.bytes && (!expected.sha256 || expected.sha256 === sha256), "INCREMENTAL_VERIFY_COPY_CHANGED");
  const after = await fileDigest(target, maximum); need(after.bytes === bytes && after.sha256 === sha256, "INCREMENTAL_VERIFY_COPY_READBACK");
  await fs.chmod(target, 0o400); return { bytes, sha256, sourcePreserved: true };
}
// Materialize one arm at a time. The caller must budget subsequent capture and
// normalization separately; the 1GiB contract is never relaxed by this helper.
async function materializeArm({ plan, capture, output, arm }) {
  need(Object.hasOwn(plan.arms, arm), "INCREMENTAL_VERIFY_ARM");
  const owner = await readJson(path.join(absolute(output), "verification-owner.json"), 16384);
  need(owner.value.kind === "keyword_monthly_incremental_verification_owner" && owner.value.root === output && /^[a-f0-9-]{36}$/.test(owner.value.token || ""), "INCREMENTAL_VERIFY_OUTPUT_OWNERSHIP");
  const savedPlan = await readJson(path.join(output, "incremental-realcopy-replay-plan.json"), MAX.manifest);
  need(fingerprint(savedPlan.value) === fingerprint(plan), "INCREMENTAL_VERIFY_PLAN_CHANGED");
  let priorBytes = owner.bytes + savedPlan.bytes + 1024 * 1024;
  for (const prior of ["before", "after", "delta"].filter(p => p !== arm)) {
    try { await checked(path.join(output, prior), true); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    const receipt = await readJson(path.join(output, `${prior}-fixture-complete.json`), MAX.manifest);
    need(receipt.value.state === "complete" && receipt.value.arm === prior && Number.isSafeInteger(receipt.value.copiedBytes) && receipt.value.copiedBytes >= 0,
      "INCREMENTAL_VERIFY_INCOMPLETE_PRIOR_ARM"); priorBytes += receipt.value.copiedBytes + receipt.bytes;
  }
  const chosen = plan.arms[arm]; need(priorBytes + chosen.physicalDatasetBytes <= MAX.scratch, "INCREMENTAL_VERIFY_SCRATCH_BOUND");
  const root = path.join(output, arm); await fs.mkdir(root, { mode: 0o700 });
  let written = 0; const copies = [], ids = new Set(chosen.runIds);
  for (const row of capture.inputFiles.filter(r => r.relative !== "history/observations.jsonl")) {
    const result = await copyExact(path.join(capture.dataDir, ...relative(row.relative).split("/")), path.join(root, ...row.relative.split("/")), row, MAX.history);
    written += result.bytes; copies.push({ relative: row.relative, ...result });
  }
  await fs.mkdir(path.join(root, "history"), { recursive: true, mode: 0o700 });
  const target = path.join(root, "history/observations.jsonl"), ordinalFile = path.join(root, "history-original-ordinals.jsonl");
  const historyOut = await fs.open(target, "wx", 0o600), ordinals = await fs.open(ordinalFile, "wx", 0o600);
  let selectedBytes = 0, ordinalBytes = 0, scan;
  try { scan = await scanHistory(plan.sourceHistory.file, ids, async r => {
    const ordinal = Buffer.from(JSON.stringify({ originalOrdinal: r.ordinal, originalOffset: r.offset, bytes: r.raw.length, sha256: r.sha256, runId: r.runId }) + "\n");
    selectedBytes += r.raw.length; ordinalBytes += ordinal.length;
    need(priorBytes + written + selectedBytes + ordinalBytes + chosen.outputBytes <= MAX.scratch, "INCREMENTAL_VERIFY_SCRATCH_BOUND");
    await historyOut.writeFile(r.raw); await ordinals.writeFile(ordinal);
  }); await historyOut.sync(); await ordinals.sync(); } finally { await historyOut.close(); await ordinals.close(); }
  need(scan.sha256 === plan.sourceHistory.sha256 && selectedBytes === chosen.historyBytes && scan.selectedRows === chosen.historyRows, "INCREMENTAL_VERIFY_HISTORY_SELECTION_CHANGED");
  const historyReadback = await fileDigest(target); need(historyReadback.sha256 === scan.selectedSha256 && historyReadback.bytes === selectedBytes, "INCREMENTAL_VERIFY_HISTORY_READBACK");
  await fs.chmod(target, 0o400); written += selectedBytes + ordinalBytes;
  for (const row of outputRows(capture, ids)) {
    need(priorBytes + written + row.bytes <= MAX.scratch, "INCREMENTAL_VERIFY_SCRATCH_BOUND");
    const result = await copyExact(path.join(absolute(capture.originalOutputs.root), ...row.relative.split("/")), path.join(root, "outputs", ...row.relative.split("/")), row, MAX.history);
    written += result.bytes; copies.push({ relative: "outputs/" + row.relative, ...result });
  }
  await preserveFixtureOutputTimes({ capture, outputsRoot: path.join(root, "outputs"), runIds: ids });
  const receipt = { schemaVersion: 1, state: "complete", kind: "derived_physical_run_prefix_fixture", arm, dataDir: root,
    planSha256: fingerprint(plan), sourceManifestSha256: plan.captureManifestSha256, runIds: chosen.runIds,
    physicalHistory: { bytes: selectedBytes, sha256: historyReadback.sha256, rows: scan.selectedRows, originalOrdinalsFile: ordinalFile },
    copiedFiles: copies.length, copiedBytes: written, boundedPriorAndCurrentBytes: priorBytes + written, maxOwnScratchBytes: MAX.scratch,
    sourcePreserved: true, sourceWrites: 0, providerCalls: 0, operatingMutations: 0, kosisDataRead: false,
    historicalCompanyMetadataReconstructed: false, omittedXlsxAndTrafficFiles: true,
    outputDirectoryMtimePolicy: "original_capture_mtime_preserved_for_stable_recorded_run_updatedAt", limitations: LIMITATIONS };
  await writeNew(path.join(output, `${arm}-fixture-complete.json`), receipt); return receipt;
}
async function preserveFixtureOutputTimes({ capture, outputsRoot, runIds }) {
  const ids = runIds instanceof Set ? runIds : new Set(runIds);
  const directories = capture.originalOutputs.directories.filter(d => d.relative === "" || ids.has(d.relative.split("/")[0]));
  for (const row of [...directories].sort((a, b) => b.relative.length - a.relative.length)) {
    const directory = path.join(outputsRoot, ...row.relative.split("/").filter(Boolean));
    try { await checked(directory, true); } catch (e) { if (e.code !== "ENOENT") throw e; await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await checked(directory, true); }
    need(/^\d+$/.test(String(row.stamp?.mtimeNs || "")), "INCREMENTAL_VERIFY_DIRECTORY_TIME_UNKNOWN");
    const seconds = Number(BigInt(row.stamp.mtimeNs)) / 1e9; await fs.utimes(directory, seconds, seconds);
  }
}
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const entry of Object.values(value)) deepFreeze(entry); }
  return value;
}
// Declare the exact known fixture inventory. No readdir/walk is used; the
// isolated child's readonly output guard can independently reject extra files.
async function freezeDeclaredOutputs({ capture, fixtureDataDir, runIds }) {
  const root = path.join(absolute(fixtureDataDir), "outputs"), rows = outputRows(capture, new Set(runIds));
  const files = [], directories = new Set([""]);
  for (const row of rows) {
    const file = path.join(root, ...relative(row.relative).split("/")), read = await fileDigest(file);
    need(read.bytes === row.bytes, "INCREMENTAL_VERIFY_OUTPUT_BYTES_CHANGED");
    files.push({ relative: row.relative, bytes: read.bytes, sha256: read.sha256, stamp: read.stat });
    let directory = path.posix.dirname(row.relative);
    while (directory !== ".") { directories.add(directory); directory = path.posix.dirname(directory); }
  }
  const declaredDirectories = [];
  for (const relative of [...directories].sort()) declaredDirectories.push({ relative, stamp: stamp(await checked(path.join(root, ...relative.split("/").filter(Boolean)), true)) });
  return deepFreeze({ root, files, fileCount: files.length, directories: declaredDirectories, directoryCount: declaredDirectories.length,
    copied: false, writeAllowed: false, declarationBasis: "exact_prior_capture_allowlist_and_owned_fixture_readback" });
}
async function prepareContextWorkData({ plan, capture, output, codeRoot }) {
  // Incremental catalog/history are supplied by state. Only existing capacity
  // and calendar dependencies are needed in the private normalization workspace.
  const workDataDir = path.join(absolute(output), "incremental-work-data"); await fs.mkdir(workDataDir, { mode: 0o700 });
  let seed = null;
  if (codeRoot) seed = await require(path.join(codeRoot, "scripts/lib/keyword_monthly_incremental_inputs.cjs")).seedDependencies({ dataDir: capture.dataDir, workDataDir });
  else for (const row of capture.inputFiles.filter(r => !["company_master/companies.json", "history/observations.jsonl"].includes(r.relative))) {
      await copyExact(path.join(capture.dataDir, ...relative(row.relative).split("/")), path.join(workDataDir, ...row.relative.split("/")), row, MAX.history);
    }
  await writeNew(path.join(output, "incremental-work-data-complete.json"), { schemaVersion: 1, state: "complete", workDataDir,
    planSha256: fingerprint(plan), seed, sourceWrites: 0, providerCalls: 0 });
  return workDataDir;
}
async function concatDigest(files) {
  const h = crypto.createHash("sha256"); let bytes = 0;
  for (const file of files) { const before = await checked(file), fd = await fs.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0));
    try { need(same(before, await fd.stat({ bigint: true })), "INCREMENTAL_VERIFY_INPUT_CHANGED");
      for await (const chunk of fd.createReadStream({ autoClose: false })) { bytes += chunk.length; h.update(chunk); }
      need(same(before, await fd.stat({ bigint: true })) && same(before, await checked(file)), "INCREMENTAL_VERIFY_INPUT_CHANGED");
    } finally { await fd.close(); }
  }
  return { bytes, sha256: h.digest("hex") };
}
// Fixture writer phase, between isolated reader children. This intentionally
// evolves only the owned before fixture; the independent after fixture stays
// unchanged. A physical concatenation check proves retained relative row order.
async function appendPhysicalFixtureDelta({ plan, capture, output, codeRoot, now }) {
  const beforeReceipt = await readJson(path.join(output, "before-fixture-complete.json"), MAX.manifest), afterReceipt = await readJson(path.join(output, "after-fixture-complete.json"), MAX.manifest),
    deltaReceipt = await readJson(path.join(output, "delta-fixture-complete.json"), MAX.manifest);
  const dataDir = beforeReceipt.value.dataDir, deltaDir = deltaReceipt.value.dataDir;
  need(dataDir === path.join(output, "before") && deltaDir === path.join(output, "delta") && afterReceipt.value.dataDir === path.join(output, "after"), "INCREMENTAL_VERIFY_OUTPUT_OWNERSHIP");
  const historyFile = path.join(dataDir, "history/observations.jsonl"), deltaFile = path.join(deltaDir, "history/observations.jsonl");
  const beforeDigest = await fileDigest(historyFile), deltaDigest = await fileDigest(deltaFile), combined = await concatDigest([historyFile, deltaFile]);
  need(beforeDigest.sha256 === beforeReceipt.value.physicalHistory.sha256 && deltaDigest.sha256 === deltaReceipt.value.physicalHistory.sha256
    && combined.sha256 === afterReceipt.value.physicalHistory.sha256 && combined.bytes === afterReceipt.value.physicalHistory.bytes,
  "INCREMENTAL_VERIFY_DELTA_NOT_PHYSICAL_APPEND");
  const stateModule = require(path.join(absolute(codeRoot), "scripts/lib/keyword_monthly_incremental_state.cjs"));
  const { createKeywordMonthlySourceDelta } = require(path.join(codeRoot, "scripts/lib/keyword_monthly_source_delta.cjs"));
  const outbox = createKeywordMonthlySourceDelta({ dataDir, now: () => new Date(now) });
  const beforeStamp = await stateModule.stamp(historyFile), rawRows = [], deltaRunIds = new Set(plan.arms.delta.runIds);
  const selected = await scanHistory(deltaFile, deltaRunIds, r => { rawRows.push(JSON.parse(r.raw.toString("utf8").replace(/^\uFEFF/, ""))); });
  need(selected.selectedRows === plan.arms.delta.historyRows && selected.bytes === selected.selectedBytes, "INCREMENTAL_VERIFY_DELTA_ROWS_CHANGED");
  // Copy new run bodies without replacing the old runs' inodes or timestamps.
  const additions = [];
  for (const row of outputRows(capture, deltaRunIds)) {
    const source = path.join(deltaDir, "outputs", ...row.relative.split("/")), pinned = await fileDigest(source);
    const copied = await copyExact(source, path.join(dataDir, "outputs", ...row.relative.split("/")), { bytes: row.bytes, sha256: pinned.sha256, stamp: pinned.stat }, MAX.history);
    additions.push({ relative: row.relative, ...copied });
  }
  await preserveFixtureOutputTimes({ capture, outputsRoot: path.join(dataDir, "outputs"), runIds: deltaRunIds });
  await fs.chmod(historyFile, 0o600);
  const input = await fs.open(deltaFile, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0)), target = await fs.open(historyFile, "a");
  try { for await (const chunk of input.createReadStream({ autoClose: false })) await target.writeFile(chunk); await target.sync(); }
  finally { await input.close(); await target.close(); await fs.chmod(historyFile, 0o400); }
  const afterStamp = await stateModule.stamp(historyFile), afterDigest = await fileDigest(historyFile);
  need(afterDigest.sha256 === combined.sha256 && afterDigest.bytes === combined.bytes, "INCREMENTAL_VERIFY_DELTA_APPEND_READBACK");
  const event = await outbox.recordHistoryDelta({ rows: rawRows, sourceStamp: { before: beforeStamp, after: afterStamp }, indexUpdated: true,
    runId: plan.arms.delta.runIds.length === 1 ? plan.arms.delta.runIds[0] : null });
  need(event.status === "complete", "INCREMENTAL_VERIFY_DELTA_EVENT_INCOMPLETE");
  const receipt = { schemaVersion: 1, state: "complete", dataDir, eventId: event.eventId, eventSha256: event.eventSha256,
    historyRows: rawRows.length, historyBytesAppended: deltaDigest.bytes, beforeHistorySha256: beforeDigest.sha256, afterHistorySha256: afterDigest.sha256,
    physicalAfterOracleHistoryEqual: true, existingRunBodiesReplaced: 0, addedRunOutputFiles: additions.length, companyDeltaEvents: 0,
    fixtureSourceHistoryAppends: 1, canonicalSourceWrites: 0, providerCalls: 0, operatingMutations: 0, historicalCompanyMetadataReconstructed: false };
  await writeNew(path.join(output, "physical-delta-appended.json"), receipt); return receipt;
}
// Called inside the root's network-denied child. The caller installs and reads
// back its filesystem/kernel guards; this helper makes no isolation claim.
async function normalizePhysicalStep({ mode, plan, capture, fixtureDataDir, workDataDir, codeRoot, capturedAt, admission = async () => {}, onNormalized = null }) {
  need(["full", "incremental"].includes(mode), "INCREMENTAL_VERIFY_NORMALIZATION_MODE");
  const { buildSourceWiring } = require(path.join(absolute(codeRoot), "scripts/lib/keyword_monthly_source_wiring.cjs")),
    { normalizePair } = require(path.join(codeRoot, "scripts/lib/keyword_monthly_incremental_normalize.cjs"));
  const isBefore = fixtureDataDir === path.join(path.dirname(fixtureDataDir), "before");
  let runIds = isBefore ? plan.arms.before.runIds : plan.arms.after.runIds;
  if (mode === "incremental") {
    // Presence of the explicit append receipt distinguishes the same evolving
    // authoritative fixture from its initial 39-run bootstrap state.
    try { const r = await readJson(path.join(path.dirname(fixtureDataDir), "physical-delta-appended.json"), MAX.manifest); need(r.value.dataDir === fixtureDataDir, "INCREMENTAL_VERIFY_DELTA_RECEIPT"); runIds = plan.arms.after.runIds; }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  const { metadataInventory } = require(path.join(codeRoot, "scripts/lib/keyword_monthly_incremental_inputs.cjs"));
  const inventory = await metadataInventory({ dataDir: fixtureDataDir }), outputs = deepFreeze(inventory.outputs), expectedOutputs = outputRows(capture, new Set(runIds));
  need(outputs.files.length === expectedOutputs.length && outputs.files.every(f => expectedOutputs.some(e => e.relative === f.relative && e.bytes === f.bytes)), "INCREMENTAL_VERIFY_STEP_OUTPUT_DECLARATION");
  const wiringDataDir = mode === "full" ? fixtureDataDir : workDataDir;
  const metadataWiring = buildSourceWiring({ codeRoot, copyDataDir: wiringDataDir, now: capturedAt, readOnlyOriginalOutputs: outputs.root, streamHistoryOnly: true });
  const runs = await metadataWiring.listRuns(), regionMaster = await readJson(path.join(codeRoot, "web/data/region_master.json"), MAX.manifest);
  need(Array.isArray(regionMaster.value.units) && runs.length === runIds.length && runs.every(r => runIds.includes(runId(r))), "INCREMENTAL_VERIFY_STEP_METADATA");
  let context = null, wiring = metadataWiring; const dependencyRecords = new Map();
  if (mode === "incremental") {
    const { createContext } = require(path.join(codeRoot, "scripts/lib/keyword_monthly_incremental_context.cjs"));
    context = await createContext({ dataDir: fixtureDataDir, codeRoot, workDataDir, capturedAt, outputs, runs, regions: regionMaster.value.units,
      bootstrapAllowed: true, admission, onRunDependency: record => {
        const key = fingerprint(record), saved = dependencyRecords.get(key) || { ...record, calls: 0 }; saved.calls++; dependencyRecords.set(key, saved);
      } }); wiring = context.wiring;
  }
  const results = [];
  for (const request of plan.queries) { await admission(); const normalized = await normalizePair({ wiring, keyword: plan.keyword, month: request.month,
    cutoffDate: request.cutoffDate, capturedAt, checkpoint: admission });
    results.push(onNormalized ? await onNormalized({ request, ...normalized }) : { request, ...normalized });
  }
  await admission(); if (context) await context.assertCurrent(); wiring.assertCodeCurrent();
  return { mode, context, results, runs, outputs, metrics: context ? context.metrics() : { source: wiring.metrics },
    runDependencies: [...dependencyRecords.values()], bootstrap: context?.bootstrap ?? null, physicalNormalization: true, isolationClaim: false };
}
function compareRunDependencies(before, after) {
  const fields = ["runSha256", "filesSha256", "companyInputsSha256", "productCapacityEvidenceRevision", "codeFingerprint"];
  const groups = new Map(), beforeRuns = new Set(before.map(r => r.runId));
  for (const row of before) { const key = row.runId + "|" + row.targetCompanyIdsSha256; const list = groups.get(key) || []; list.push(row); groups.set(key, list); }
  const rows = [], reasons = {};
  for (const row of after) {
    const candidates = groups.get(row.runId + "|" + row.targetCompanyIdsSha256) || [];
    let reason, changedComponents = [];
    if (!beforeRuns.has(row.runId)) reason = "new_run";
    else if (!candidates.length) reason = "existing_run_target_company_set_changed";
    else if (candidates.some(c => c.revision === row.revision)) reason = "same_dependency_revision";
    else { reason = "existing_run_dependency_components_changed";
      changedComponents = candidates.map(c => fields.filter(k => c[k] !== row[k])).sort((a, b) => a.length - b.length)[0]; }
    reasons[reason] = (reasons[reason] || 0) + 1;
    rows.push({ runId: row.runId, targetCompanyIdsSha256: row.targetCompanyIdsSha256, reason, changedComponents, revision: row.revision });
  }
  return { beforeUniqueUnits: before.length, afterUniqueUnits: after.length, reasons, rows,
    classificationLimit: "Changed dependency hashes justify invalidation under the declared key contract; necessity of every component is not inferred from hashes alone." };
}
function deepDifferences(actual, expected, maximum = 100) {
  const differences = []; let visited = 0, truncated = false;
  function visit(a, e, at, depth) {
    if (++visited > 1000000 || differences.length >= maximum || depth > 96) { truncated = true; return; }
    if (Object.is(a, e)) return;
    const aKind = a === null ? "null" : Array.isArray(a) ? "array" : typeof a, eKind = e === null ? "null" : Array.isArray(e) ? "array" : typeof e;
    if (aKind !== eKind || aKind !== "object" && aKind !== "array") { differences.push({ path: at, actualType: aKind, expectedType: eKind,
      actualSha256: fingerprint(a), expectedSha256: fingerprint(e) }); return; }
    if (aKind === "array" && a.length !== e.length) differences.push({ path: at + "/length", actualLength: a.length, expectedLength: e.length });
    const keys = [...new Set([...Object.keys(a), ...Object.keys(e)])];
    for (const key of keys) { if (differences.length >= maximum) { truncated = true; break; }
      const next = at + "/" + key.replace(/~/g, "~0").replace(/\//g, "~1");
      if (Object.hasOwn(a, key) !== Object.hasOwn(e, key)) differences.push({ path: next, actualPresent: Object.hasOwn(a, key), expectedPresent: Object.hasOwn(e, key) });
      else visit(a[key], e[key], next, depth + 1);
    }
  }
  visit(actual, expected, "", 0); return { differences, recordedDifferences: differences.length, truncated, visitedNodes: visited };
}
function purePairSnapshot(source, request, now, codeRoot) {
  const { buildMonthlyReportSnapshot } = require(path.join(codeRoot, "scripts/lib/monthly_reports.cjs")),
    { sourceForKeywordMonthlyRequest } = require(path.join(codeRoot, "scripts/lib/keyword_monthly_analysis.cjs")),
    { previousMonthlyReportRequest, buildMonthlyComparison } = require(path.join(codeRoot, "scripts/lib/monthly_report_comparison.cjs"));
  const currentRequest = { type: "keyword", targetId: request.targetId || request.keyword, month: request.month, cutoffDate: request.cutoffDate },
    previousRequest = previousMonthlyReportRequest(currentRequest);
  const current = buildMonthlyReportSnapshot(currentRequest, sourceForKeywordMonthlyRequest(source, currentRequest), now),
    previous = buildMonthlyReportSnapshot(previousRequest, sourceForKeywordMonthlyRequest(source, previousRequest), now);
  current.comparisonByProduct = Object.fromEntries(PRODUCTS.map(productType => [productType,
    current.sources.observations.some(r => r.productType === productType) && previous.sources.observations.some(r => r.productType === productType)
      ? buildMonthlyComparison(current, previous, { productType }) : null]));
  current.comparison = current.comparisonByProduct.lodging; return current;
}
function candidateAudit(source, snapshot, admittedRunIds = []) {
  const groups = new Map();
  for (const row of source.observations || []) { const key = rowKey(row); groups.set(key, (groups.get(key) || 0) + 1); }
  const admitted = new Set(admittedRunIds);
  return { normalizedObservationCandidates: (source.observations || []).length, normalizedRankCandidates: (source.rankObservations || []).length,
    normalizedRecoveryCandidates: (source.savedProductRecoveries || []).length, distinctObservationKeys: groups.size,
    maximumCandidatesPerCompanyStayProduct: Math.max(0, ...groups.values()), selectedNormalRows: snapshot.sources.observations.length,
    selectedNormalUniqueKeys: new Set(snapshot.sources.observations.map(rowKey)).size,
    admittedRunObservationCandidates: (source.observations || []).filter(r => admitted.has(String(r.runId || ""))).length,
    products: PRODUCTS.map(productType => { const normal = snapshot.sources.observations.filter(r => r.productType === productType),
      partial = snapshot.sources.partialEvidence.filter(r => r.productType === productType && r.includedInPartialSubtotal === true), keys = new Set(normal.map(rowKey));
      return { productType, selectedNormalRows: normal.length, uniqueNormalKeys: keys.size, includedPartialRows: partial.length,
        uniqueIncludedPartialKeys: new Set(partial.map(rowKey)).size, normalPartialDisjoint: partial.every(r => !keys.has(rowKey(r))),
        admittedRunSelectedRows: normal.filter(r => admitted.has(String(r.runId || ""))).length }; }), partial: partialAccounting(snapshot) };
}
async function writeCompressedNew(file, value) {
  const raw = Buffer.from(JSON.stringify(value)); need(raw.length <= MAX.json, "INCREMENTAL_VERIFY_JSON_BOUND");
  const bytes = require("node:zlib").gzipSync(raw, { level: 6 }); await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  const readback = await fileDigest(file); need(readback.sha256 === hash(bytes), "INCREMENTAL_VERIFY_WRITE_READBACK");
  return { file, bytes: bytes.length, sha256: readback.sha256, rawBytes: raw.length, rawSha256: hash(raw) };
}
async function readCompressedVerified(descriptor) {
  const current = await fileDigest(descriptor.file); need(current.bytes === descriptor.bytes && current.sha256 === descriptor.sha256, "INCREMENTAL_VERIFY_ORACLE_CHANGED");
  const raw = require("node:zlib").gunzipSync(await fs.readFile(descriptor.file), { maxOutputLength: MAX.json });
  need(raw.length === descriptor.rawBytes && hash(raw) === descriptor.rawSha256, "INCREMENTAL_VERIFY_ORACLE_CHANGED"); return JSON.parse(raw);
}
// The strict entry-point guard calls this function after installing kernel,
// filesystem and child-process restrictions. Its returned status covers only
// the explicitly executed frozen physical replay; unexecuted cases stay listed.
async function executeContextReplay({ codeRoot, fixtureRoot, capturedAt, admission = async () => {}, onProgress = () => {} }) {
  absolute(codeRoot); absolute(fixtureRoot); need(Number.isFinite(Date.parse(capturedAt)), "INCREMENTAL_VERIFY_CLOCK");
  const owner = await readJson(path.join(fixtureRoot, "verification-owner.json"), 16384), savedPlan = await readJson(path.join(fixtureRoot, "incremental-realcopy-replay-plan.json"), MAX.manifest), plan = savedPlan.value;
  need(owner.value.root === fixtureRoot && owner.value.kind === "keyword_monthly_incremental_verification_owner" && plan.status === "prepared", "INCREMENTAL_VERIFY_OUTPUT_OWNERSHIP");
  // An exact metadata-only copy is staged before isolation. No access to the
  // old saved-copy namespace is needed during execution.
  const captureRead = await readJson(path.join(fixtureRoot, "frozen-capture-metadata.json"), MAX.manifest);
  need(captureRead.sha256 === plan.captureManifestSha256, "INCREMENTAL_VERIFY_CAPTURE_METADATA_CHANGED");
  const capture = { ...captureRead.value, dataDir: path.join(fixtureRoot, "before") };
  try { await checked(path.join(fixtureRoot, "physical-delta-appended.json")); need(false, "INCREMENTAL_VERIFY_REPLAY_ALREADY_ADVANCED"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const output = path.join(fixtureRoot, "context-replay-" + crypto.randomUUID()); await fs.mkdir(output, { mode: 0o700 });
  async function diagnosed(phase, operation) {
    try { return await operation(); } catch (error) {
      const diagnostic = { schemaVersion: 1, phase, errorName: error?.name || "Error", errorCode: /^[A-Z][A-Z0-9_]{1,150}$/.test(error?.code || "") ? error.code : null,
        frames: String(error?.stack || "").split("\n").slice(1).filter(line => /^\s+at /.test(line)).slice(0, 12),
        errorMessageExported: false, exportedBusinessRows: 0 };
      await writeNew(path.join(output, phase + "-failure.json"), diagnostic).catch(() => {});
      if (!error.code) error.code = "KEYWORD_INCREMENTAL_REPLAY_RUNTIME_FAILED"; throw error;
    }
  }
  const workDataDir = await diagnosed("seed", () => prepareContextWorkData({ plan, capture, output, codeRoot })), oracle = {}, scopes = [], phases = [];
  const check = (name, passed, extra = {}) => ({ name, passed: passed === true, ...extra });
  async function full(phase, dataDir) {
    const startedAt = Date.now();
    await onProgress({ phase, status: "starting" });
    const r = await normalizePhysicalStep({ mode: "full", plan, capture, fixtureDataDir: dataDir, workDataDir, codeRoot, capturedAt, admission,
      onNormalized: async normalized => {
        const snapshot = purePairSnapshot(normalized.source, normalized.request, capturedAt, codeRoot), key = phase + ":" + normalized.request.month;
        oracle[key] = await writeCompressedNew(path.join(output, `${phase}-${normalized.request.month}-oracle.json.gz`), { source: normalized.source, snapshot });
        return { request: normalized.request, inputSha256: normalized.inputSha256, inputBytes: normalized.inputBytes,
          sourceSummary: sourceSummary(normalized.source), candidateAudit: candidateAudit(normalized.source, snapshot, plan.arms.delta.runIds), oracle: oracle[key] };
      } });
    const small = { phase, mode: "full", elapsedMs: Date.now() - startedAt, metrics: r.metrics, scopes: r.results };
    phases.push(small); await writeNew(path.join(output, phase + "-complete.json"), small); await onProgress({ phase, status: "complete" });
  }
  async function incremental(phase, expectedPhase) {
    const startedAt = Date.now();
    await onProgress({ phase, status: "starting" });
    const r = await normalizePhysicalStep({ mode: "incremental", plan, capture, fixtureDataDir: path.join(fixtureRoot, "before"), workDataDir,
      codeRoot, capturedAt, admission, onNormalized: async normalized => {
        const expected = await readCompressedVerified(oracle[expectedPhase + ":" + normalized.request.month]), snapshot = purePairSnapshot(normalized.source, normalized.request, capturedAt, codeRoot);
        // The published source is JSON bytes. Optional undefined object fields
        // are omitted by that existing transport contract on both sides; null
        // and numeric zero remain distinct and are checked independently.
        const actualBytes = Buffer.from(JSON.stringify(normalized.source)), expectedBytes = Buffer.from(JSON.stringify(expected.source)), transportedSource = JSON.parse(actualBytes);
        const sourceComparison = compareNormalizedSources(transportedSource, expected.source), snapshotComparison = compareSnapshots(snapshot, expected.snapshot);
        const coreDifferences = sourceComparison.passed && snapshotComparison.passed ? { differences: [], recordedDifferences: 0, truncated: false }
          : { source: deepDifferences(transportedSource, expected.source), snapshot: deepDifferences(snapshot, expected.snapshot) };
        const inputBytesEqual = actualBytes.equals(expectedBytes), financialConditions = PRODUCTS.map(productType => ({ productType,
          summaryEqual: fingerprint(snapshot.summary[productType]) === fingerprint(expected.snapshot.summary[productType]),
          dailyEqual: fingerprint(snapshot.daily.map(d => d[productType])) === fingerprint(expected.snapshot.daily.map(d => d[productType])),
          companyEqual: fingerprint(snapshot.companies.map(c => [companyId(c), c.summary[productType], c.daily.map(d => d[productType])]))
            === fingerprint(expected.snapshot.companies.map(c => [companyId(c), c.summary[productType], c.daily.map(d => d[productType])])),
          comparisonEqual: fingerprint(snapshot.comparisonByProduct[productType]) === fingerprint(expected.snapshot.comparisonByProduct[productType]) }));
        const result = { phase, request: normalized.request, passed: inputBytesEqual && sourceComparison.passed && snapshotComparison.passed,
          inputBytesEqual, actualInputSha256: hash(actualBytes), expectedInputSha256: hash(expectedBytes), sourceComparison, snapshotComparison,
          coreDifferences, candidateAudit: candidateAudit(normalized.source, snapshot, plan.arms.delta.runIds), financialConditions };
        scopes.push(result); return result;
      } });
    const small = { phase, mode: "incremental", elapsedMs: Date.now() - startedAt, bootstrap: r.bootstrap, metrics: r.metrics, runDependencies: r.runDependencies, scopeCount: r.results.length,
      adoptedEventCount: r.context?.state.appliedEvents.length, stateGeneration: r.context?.state.generation, stateSha256: r.context?.current.stateSha256,
      sourceBootstrapEvidence: r.context?.state.bootstrapSources || null,
      allScopesPassed: r.results.every(s => s.passed) };
    phases.push(small); await writeNew(path.join(output, phase + "-complete.json"), small); await onProgress({ phase, status: "complete" });
  }
  await diagnosed("full-before", () => full("full-before", path.join(fixtureRoot, "before")));
  await diagnosed("incremental-bootstrap", () => incremental("incremental-bootstrap", "full-before"));
  const delta = await diagnosed("physical-delta-append", () => appendPhysicalFixtureDelta({ plan, capture, output: fixtureRoot, codeRoot, now: capturedAt }));
  await onProgress({ phase: "physical-delta-append", status: "complete", rows: delta.historyRows });
  await diagnosed("full-after", () => full("full-after", path.join(fixtureRoot, "after")));
  await diagnosed("incremental-after", () => incremental("incremental-after", "full-after"));
  await diagnosed("incremental-repeat", () => incremental("incremental-repeat", "full-after"));
  const after = phases.find(p => p.phase === "incremental-after"), repeated = phases.find(p => p.phase === "incremental-repeat");
  const checks = [check("all_physical_scopes_exact", scopes.every(s => s.passed)),
    check("after_did_not_rebootstrap", after.bootstrap === false), check("after_reads_no_authoritative_full_master", after.metrics.originalMasterBodyReads === 0),
    check("after_reads_no_authoritative_full_history", after.metrics.originalHistoryBodyReads === 0),
    check("new_delta_rows_adopted_once", after.metrics.deltaHistoryRows === delta.historyRows && after.metrics.adoptedEvents === 1),
    check("repeat_did_not_read_authoritative_full_sources", repeated.metrics.originalMasterBodyReads === 0 && repeated.metrics.originalHistoryBodyReads === 0),
    check("repeat_adopted_no_more_events_or_rows", repeated.metrics.adoptedEvents === 0 && repeated.metrics.deltaHistoryRows === 0),
    check("repeat_source_generation_stable", repeated.stateGeneration === after.stateGeneration)];
  const result = { schemaVersion: 1, kind: "keyword_monthly_incremental_context_physical_replay", status: checks.every(c => c.passed) ? "verified" : "failed",
    fixtureRoot, output, capturedAt, calculationTimeFixtureOnly: true, captureTimesUnmodified: true, planSha256: fingerprint(plan),
    checks, phases, scopes, delta, fourConditions: plan.fourConditions,
    maximumCandidatesPerCompanyStayProduct: Math.max(0, ...scopes.map(s => s.candidateAudit.maximumCandidatesPerCompanyStayProduct)),
    runDependencyChanges: compareRunDependencies(phases.find(p => p.phase === "incremental-bootstrap").runDependencies, after.runDependencies),
    canonicalSourceWrites: 0, fixtureSourceHistoryAppends: 1, operatingMutations: 0, providerCalls: 0, kosisDataRead: false, exportedBusinessRows: 0,
    isolationVerifiedByCallerRequired: true, unexecutedCases: ["reverse_event_delivery", "crash_recovery", "dependency_drift", "company_delta_from_real_history"], limitations: LIMITATIONS };
  result.resultFile = path.join(output, "context-replay-verification.json"); await writeNew(result.resultFile, result); return result;
}
// Deliberately callback based: normalization must be supplied by the reviewed
// isolated physical-copy runner, rather than a row-splitting substitute.
async function verifyLayerB({ plan, fixtures, normalizeFull, normalizeDelta, bootstrap, applyDelta, readStateSource, buildSnapshot, now }) {
  for (const fn of [normalizeFull, normalizeDelta, bootstrap, applyDelta, readStateSource, buildSnapshot]) need(typeof fn === "function", "INCREMENTAL_VERIFY_ADAPTER_REQUIRED");
  need(fixtures?.before && fixtures?.after && fixtures?.delta && Number.isFinite(Date.parse(now)), "INCREMENTAL_VERIFY_FIXTURES_REQUIRED");
  const results = [];
  for (const request of plan.queries) {
    const common = { request, now, plan, provenance: "derived_physical_prefix_latest_frozen_company_metadata" };
    const before = await normalizeFull({ ...common, fixture: fixtures.before, arm: "before" });
    const after = await normalizeFull({ ...common, fixture: fixtures.after, arm: "after" });
    const delta = await normalizeDelta({ ...common, fixture: fixtures.delta, arm: "delta", runIds: plan.arms.delta.runIds });
    need(before?.physicalNormalization === true && after?.physicalNormalization === true && delta?.physicalNormalization === true,
      "INCREMENTAL_VERIFY_PHYSICAL_NORMALIZATION_REQUIRED");
    const state = await bootstrap({ ...common, source: before.source });
    const first = await applyDelta({ ...common, state, source: delta.source, runIds: plan.arms.delta.runIds });
    const actual = await readStateSource({ ...common, state: first.state || state });
    const sourceComparison = compareNormalizedSources(actual, after.source);
    const actualSnapshot = await buildSnapshot({ ...common, source: actual }), expectedSnapshot = await buildSnapshot({ ...common, source: after.source });
    const snapshotComparison = compareSnapshots(actualSnapshot, expectedSnapshot);
    const repeated = await applyDelta({ ...common, state: first.state || state, source: delta.source, runIds: plan.arms.delta.runIds });
    const repeatedSource = await readStateSource({ ...common, state: repeated.state || first.state || state });
    const repetition = compareNormalizedSources(repeatedSource, actual);
    results.push({ request, passed: sourceComparison.passed && snapshotComparison.passed && repetition.passed,
      sourceComparison, snapshotComparison, repeatedDeltaUnchanged: repetition.passed,
      fullOracleProofs: [before.proof, after.proof], deltaProof: delta.proof, financialConditions: PRODUCTS.map(productType => ({ productType,
        summaryEqual: fingerprint(actualSnapshot.summary?.[productType]) === fingerprint(expectedSnapshot.summary?.[productType]),
        dailyEqual: fingerprint((actualSnapshot.daily || []).map(d => d[productType])) === fingerprint((expectedSnapshot.daily || []).map(d => d[productType])),
        companyEqual: fingerprint((actualSnapshot.companies || []).map(c => [companyId(c), c.summary?.[productType], c.daily?.map(d => d[productType])]))
          === fingerprint((expectedSnapshot.companies || []).map(c => [companyId(c), c.summary?.[productType], c.daily?.map(d => d[productType])])) })) });
  }
  return { schemaVersion: 1, kind: "keyword_monthly_incremental_physical_replay_verification", status: results.every(r => r.passed) ? "passed" : "failed",
    layerBAccepted: results.every(r => r.passed), planSha256: fingerprint(plan), fixedCalculationTime: now, actualFixtureCaptureTimesPreserved: true,
    acceptanceScope: "one_physical_before_after_delta_and_identical_delta_replay_only",
    scopes: results, sourceWrites: 0, providerCalls: 0, operatingMutations: 0, kosisDataRead: false,
    unexecutedSequences: plan.plannedSequences.filter(s => s !== "same_delta_twice"), limitations: LIMITATIONS };
}
function args(values) {
  const result = { oracleCompletes: [] }, names = { "capture-manifest": "captureManifest", "oracle-complete": "oracleCompletes", keyword: "keyword", output: "output", "materialize-arm": "materializeArm", "before-count": "beforeCount" };
  for (let i = 0; i < values.length; i += 2) { const name = values[i]?.slice(2), key = names[name], value = values[i + 1];
    need(values[i]?.startsWith("--") && key && value && !value.startsWith("--") && (key === "oracleCompletes" || result[key] === undefined), "INCREMENTAL_VERIFY_ARGUMENTS");
    if (key === "oracleCompletes") result[key].push(value); else result[key] = value;
  }
  need(result.captureManifest && result.oracleCompletes.length && result.keyword && result.output, "INCREMENTAL_VERIFY_ARGUMENTS");
  if (result.beforeCount !== undefined) { need(/^\d+$/.test(result.beforeCount), "INCREMENTAL_VERIFY_ARGUMENTS"); result.beforeCount = Number(result.beforeCount); }
  if (result.materializeArm) need(["before", "after", "delta"].includes(result.materializeArm), "INCREMENTAL_VERIFY_ARM");
  return result;
}
async function main(values) {
  const options = args(values), prepared = await preparePlan(options);
  const owner = await createOwnedOutput(absolute(options.output), [prepared.capture.copyRoot, prepared.capture.sourceDataDir,
    ...prepared.plan.existingFullOracles.map(r => path.dirname(r.sourceFile))]);
  const planFile = await writeNew(path.join(owner.root, "incremental-realcopy-replay-plan.json"), prepared.plan);
  const fixture = options.materializeArm ? await materializeArm({ ...prepared, output: owner.root, arm: options.materializeArm }) : null;
  return { status: "prepared", layerBAccepted: false, planFile, planSha256: fingerprint(prepared.plan), runCount: prepared.plan.runs.length,
    bootstrapRunCount: prepared.plan.bootstrapRunCount, deltaRunCount: prepared.plan.deltaRunCount, armBytes: Object.fromEntries(Object.entries(prepared.plan.arms).map(([k, v]) => [k, v.physicalDatasetBytes])),
    fixtureFile: fixture ? path.join(owner.root, `${options.materializeArm}-fixture-complete.json`) : null,
    sourceWrites: 0, providerCalls: 0, operatingMutations: 0, kosisDataRead: false };
}
if (require.main === module) main(process.argv.slice(2)).then(r => process.stdout.write(JSON.stringify(r) + "\n")).catch(e => {
  process.stderr.write(JSON.stringify({ status: "failed", code: /^INCREMENTAL_VERIFY_[A-Z_]+$/.test(e.code || "") ? e.code : "INCREMENTAL_VERIFY_FAILED" }) + "\n"); process.exitCode = 1;
});
module.exports = { MAX, LIMITATIONS, canonical, fingerprint, multiset, nullZeroShape, sourceSummary, compareNormalizedSources,
  partialAccounting, compareSnapshots, inspectOracles, scanHistory, outputRows, replayPlan, preparePlan, createOwnedOutput,
  materializeArm, preserveFixtureOutputTimes, freezeDeclaredOutputs, prepareContextWorkData, concatDigest, appendPhysicalFixtureDelta, normalizePhysicalStep,
  deepDifferences, purePairSnapshot, candidateAudit, compareRunDependencies, executeContextReplay, verifyLayerB, args, main };
