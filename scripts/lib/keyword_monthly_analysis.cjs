"use strict";

// This module deliberately has no collector, queue, source-service or context
// dependency. The explicit offline publisher is separate from the runtime API.
const fs = require("node:fs/promises");
const constants = require("node:fs").constants;
const path = require("node:path");
const crypto = require("node:crypto");
const { buildMonthlyReportSnapshot } = require("./monthly_reports.cjs");
const { buildMonthlyComparison, previousMonthlyReportRequest } = require("./monthly_report_comparison.cjs");
const { recoveryRowDigest } = require("./saved_product_recovery.cjs");

const VERSION = "keyword-monthly-v1";
const LIMITS = Object.freeze({ indexBytes: 1024 * 1024, projectionBytes: 32 * 1024 * 1024,
  observations: 50000, rankObservations: 50000, companies: 1000, runs: 10000, scopes: 4096 });
const DAY = 86400000;
const SHA = /^[a-f0-9]{64}$/;
const safeCode = value => /^[A-Z][A-Z0-9_]{0,99}$/.test(value || "") ? value : null;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
function fault(code, statusCode = 503) { return Object.assign(new Error(code), { code, statusCode }); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value, max = 300) { return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value && value >= "2000-01-01";
}
function month(value) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(value || "") && value >= "2000-01"; }
function iso(value) { return typeof value === "string" && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && date(value.slice(0, 10)) && Number.isFinite(Date.parse(value)); }
function kstDay(value) { return new Date(Number(value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value)) + 9 * 3600000).toISOString().slice(0, 10); }
function nowIso(now) { const value = typeof now === "function" ? now() : now ?? Date.now(); const out = new Date(value).toISOString(); if (!iso(out)) throw fault("KEYWORD_MONTHLY_INVALID_CLOCK"); return out; }
function status(run) { return String(typeof run.collectionQuality === "string" ? run.collectionQuality : run.collectionQuality?.status || "unknown").toLowerCase(); }
function companyId(row) { return String(row.companyId || row.companyKey || row.id || ""); }
function runId(row) { return String(row.id || row.runId || ""); }
function scopeKey(keyword, value) { return digest(JSON.stringify([VERSION, keyword, value])); }
function priorMonth(value) { const [y, m] = value.split("-").map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); }
function lastDay(value) { const [y, m] = value.split("-").map(Number); return `${value}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; }

const COMPANY_KEYS = ["companyId", "id", "companyKey", "primaryName", "companyName", "name", "regionKey", "regionLabel", "capacity", "capacitySource"];
const RUN_KEYS = ["id", "runId", "keyword", "collectedAt", "collectedAtSource", "collectionQuality", "status", "startedAt", "finishedAt", "completedAt", "errorCode", "reasonCode"];
function pick(row, keys) { return Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => [key, clone(row[key])])); }
function boundedArray(source, key, limit) {
  if (!Array.isArray(source[key]) || source[key].length > limit || source[key].some(row => !plain(row))) throw fault("KEYWORD_MONTHLY_INVALID_SOURCE");
  return source[key];
}
const RECOVERY_KEYS = ["kind", "originalRunQuality", "companyId", "runId", "date", "productType", "collectedAt", "sourceDigest", "rowDigest", "receiptId"];
function sourceRow(row) {
  // Preserve the exact normalized row: the shared engine's deterministic tie
  // and recovery certificate both hash it. Silently dropping fields would
  // change which equal-time observation wins. Reject unsafe source copies.
  const visit = (value, depth = 0) => {
    if (depth > 12) throw fault("KEYWORD_MONTHLY_INVALID_SOURCE");
    if (Array.isArray(value)) { if (value.length > 5000) throw fault("KEYWORD_MONTHLY_INVALID_SOURCE"); value.forEach(item => visit(item, depth + 1)); }
    else if (plain(value)) for (const [key, item] of Object.entries(value)) {
      if (/(?:token|secret|password|cookie|authorization|private|rawPayload|guest|customer|contact|address|account|kosis|context)/i.test(key)) throw fault("KEYWORD_MONTHLY_UNSAFE_SOURCE_FIELDS");
      visit(item, depth + 1);
    }
  };
  const copied = clone(row); visit(copied);
  if (Buffer.byteLength(JSON.stringify(copied)) > 256 * 1024) throw fault("KEYWORD_MONTHLY_SIZE_LIMIT");
  return copied;
}
function normalizeSource(source) {
  if (!plain(source)) throw fault("KEYWORD_MONTHLY_INVALID_SOURCE");
  const companies = boundedArray(source, "companies", LIMITS.companies).map(row => pick(row, COMPANY_KEYS));
  const runs = boundedArray(source, "runs", LIMITS.runs).map(row => ({ ...pick(row, RUN_KEYS), collectionQuality: { status: status(row) } }));
  const observations = boundedArray(source, "observations", LIMITS.observations).map(sourceRow);
  const rankObservations = boundedArray({ rankObservations: source.rankObservations || [] }, "rankObservations", LIMITS.rankObservations).map(sourceRow);
  const savedProductRecoveries = boundedArray({ savedProductRecoveries: source.savedProductRecoveries || [] }, "savedProductRecoveries", LIMITS.observations).map(entry => {
    if (!plain(entry.row) || !plain(entry.certificate)) throw fault("KEYWORD_MONTHLY_INVALID_RECOVERY");
    const row = sourceRow(entry.row), certificate = pick(entry.certificate, RECOVERY_KEYS);
    if (certificate.kind !== "saved_product_recovery_v1" || certificate.originalRunQuality !== "unknown" || certificate.companyId !== companyId(row)
      || certificate.runId !== String(row.runId || "") || certificate.date !== (row.stayDate || row.date) || certificate.productType !== row.productType
      || certificate.collectedAt !== row.collectedAt || ![certificate.sourceDigest, certificate.rowDigest, certificate.receiptId].every(value => SHA.test(value || ""))
      || recoveryRowDigest(row) !== certificate.rowDigest) throw fault("KEYWORD_MONTHLY_INVALID_RECOVERY");
    return { row, certificate };
  });
  if (new Set(companies.map(companyId)).size !== companies.length || companies.some(row => !text(companyId(row)))
    || new Set(runs.map(runId)).size !== runs.length || runs.some(row => !text(runId(row)) || !text(row.keyword))) throw fault("KEYWORD_MONTHLY_SOURCE_IDENTITY_CONFLICT");
  const warnings = Array.isArray(source.warnings) ? source.warnings.filter(value => typeof value === "string").slice(0, 100).map(value => value.slice(0, 1000)) : [];
  const sourceDiagnostics = plain(source.sourceDiagnostics) ? Object.fromEntries(Object.entries(source.sourceDiagnostics)
    .filter(([key, value]) => /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(key) && typeof value === "number" && Number.isFinite(value) && value >= 0).slice(0, 100)) : {};
  const specialDays = source.specialDays === undefined ? undefined : { years: (Array.isArray(source.specialDays?.years) ? source.specialDays.years : []).slice(0, 20).map(year => ({
    year: year.year, status: year.status === "ready" ? "ready" : "missing", updatedAt: iso(year.updatedAt) ? year.updatedAt : "",
    holidays: (Array.isArray(year.holidays) ? year.holidays : []).filter(item => date(item.date) && text(item.name, 100)).slice(0, 100).map(item => ({ date: item.date, name: item.name })) })) };
  return { companies, runs, observations, rankObservations, savedProductRecoveries, warnings, sourceDiagnostics, ...(specialDays ? { specialDays } : {}) };
}

function statSame(a, b) { return ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].every(key => a[key] === b[key]); }
function samePath(a, b) { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
async function checkPath(absolute, directory) {
  const resolved = path.resolve(absolute), root = path.parse(resolved).root;
  let current = root;
  for (const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || current !== resolved && !stat.isDirectory()) throw fault("KEYWORD_MONTHLY_UNSAFE_PATH");
  }
  const stat = await fs.lstat(resolved);
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) throw fault("KEYWORD_MONTHLY_UNSAFE_PATH");
  if (!samePath(await fs.realpath(resolved), resolved)) throw fault("KEYWORD_MONTHLY_UNSAFE_PATH");
  return stat;
}
async function readJson(file, maximum) {
  const before = await checkPath(file, false);
  if (before.size <= 0 || before.size > maximum) throw fault("KEYWORD_MONTHLY_SIZE_LIMIT");
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!statSame(before, opened)) throw fault("KEYWORD_MONTHLY_EVIDENCE_CHANGED");
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    if (offset !== bytes.length || !statSame(opened, await handle.stat()) || !statSame(opened, await checkPath(file, false))) throw fault("KEYWORD_MONTHLY_EVIDENCE_CHANGED");
    let value; try { value = JSON.parse(bytes.toString("utf8")); } catch { throw fault("KEYWORD_MONTHLY_INVALID_JSON"); }
    return { value, sha256: digest(bytes), bytes: bytes.length, stamp: opened };
  } finally { await handle.close(); }
}
function safeProvenance(input, sourceFingerprint, materializedAt, dataThrough, sourceDiagnostics) {
  const selectionCutoffs = input?.selectionCutoffs ?? {};
  if (!plain(selectionCutoffs) || Object.keys(selectionCutoffs).length > 1200
    || Object.entries(selectionCutoffs).some(([key, value]) => !month(key) || !date(value) || value > kstDay(materializedAt))) throw fault("KEYWORD_MONTHLY_INVALID_SELECTION_CUTOFFS");
  const provenance = { inputSha256: sourceFingerprint, materializedAt, dataThrough, originalFreshnessVerified: false,
    basis: "explicit_offline_normalized_source_copy", networkAttempted: false, contextIncluded: false,
    observationScope: ["selected_only", "normalized_multirun", "verified_history_subset"].includes(input?.observationScope) ? input.observationScope : "unspecified",
    intermediateObservationsComplete: sourceDiagnostics.intermediateObservationsComplete === 1,
    runInventoryComplete: sourceDiagnostics.runInventoryComplete === 1, selectionCutoffs: clone(selectionCutoffs) };
  if (input?.inputSha256 && input.inputSha256 !== sourceFingerprint) throw fault("KEYWORD_MONTHLY_SOURCE_FINGERPRINT_MISMATCH");
  if (Number.isSafeInteger(input?.inputBytes) && input.inputBytes >= 0) provenance.inputBytes = input.inputBytes;
  if (iso(input?.copiedAt)) provenance.copiedAt = input.copiedAt;
  return provenance;
}
function sourceMonth(row, runMap) {
  const run = runMap.get(String(row.runId || ""));
  const observedAt = row.collectedAt || run?.collectedAt;
  if (!run || !["complete", "reused", "partial"].includes(status(run)) || !iso(observedAt)
    || !row.collectedAt && run.collectedAtSource === "filesystem") return null;
  const day = kstDay(observedAt), stay = row.stayDate || row.date;
  const product = row.productType === "day-use" ? "dayuse" : row.productType;
  const inventoryMonth = date(stay) && day <= stay && ["lodging", "dayuse"].includes(product)
    && Number(row.inventoryEvidenceVersion ?? row.evidenceVersion) >= 3 ? stay.slice(0, 7) : null;
  const rankMonth = typeof row.rank !== "boolean" && Number.isInteger(Number(row.rank)) && Number(row.rank) >= 1 ? day.slice(0, 7) : null;
  return { keyword: String(row.keyword || run.keyword), inventoryMonth, rankMonth, day };
}
function activityFor(runs, complete) {
  const rows = new Map();
  for (const run of runs) {
    if (!iso(run.collectedAt) || run.collectedAtSource === "filesystem") continue;
    const value = kstDay(run.collectedAt).slice(0, 7), row = rows.get(value) || { month: value, runCount: 0, freshRunCount: 0, reusedRunCount: 0, failedRunCount: 0, partialRunCount: 0, unknownRunCount: 0 };
    row.runCount += 1;
    const field = { complete: "freshRunCount", reused: "reusedRunCount", partial: "partialRunCount", failed: "failedRunCount", blocked: "failedRunCount", missed: "failedRunCount" }[status(run)] || "unknownRunCount";
    row[field] += 1; rows.set(value, row);
  }
  return { basis: "collection_month", coverageBasis: "provided_unique_run_set", counterScope: "provided_runs_only", runInventoryComplete: complete,
    rows: [...rows.values()].sort((a, b) => a.month.localeCompare(b.month)),
    unknownTimeRunCount: runs.filter(run => !iso(run.collectedAt) || run.collectedAtSource === "filesystem").length };
}
function attemptTime(run) { return [run.finishedAt, run.completedAt, run.collectedAt, run.startedAt].find(iso) || null; }
function attempt(run) { return run ? { status: status(run), observedAt: attemptTime(run), errorCode: safeCode(run.errorCode || run.reasonCode) } : null; }

/** Explicit local/offline operation. The caller supplies an already isolated,
 * normalized source. Never call this from a GET, collector or source cache. */
async function buildKeywordMonthlyProjection({ source, sourceFingerprint, sourceProvenance, materializedAt, dataThrough, outputDir, now } = {}) {
  const at = materializedAt || nowIso(now);
  if (!SHA.test(sourceFingerprint || "") || !iso(at) || !text(outputDir, 4000)) throw fault("KEYWORD_MONTHLY_INVALID_BUILD_INPUT", 400);
  const normalized = normalizeSource(source);
  const times = [...normalized.runs.map(attemptTime), ...normalized.observations.map(row => row.collectedAt), ...normalized.rankObservations.map(row => row.collectedAt),
    ...normalized.savedProductRecoveries.map(entry => entry.row.collectedAt)].filter(iso).sort((a, b) => Date.parse(a) - Date.parse(b));
  const through = dataThrough || times.at(-1) || at;
  if (!iso(through) || Date.parse(through) > Date.parse(at) || times.some(value => Date.parse(value) > Date.parse(through))) throw fault("KEYWORD_MONTHLY_INVALID_DATA_THROUGH");
  const provenance = safeProvenance(sourceProvenance, sourceFingerprint, at, through, normalized.sourceDiagnostics);
  const runMap = new Map(normalized.runs.map(run => [runId(run), run]));
  const descriptors = new Map();
  for (const row of [...normalized.observations, ...normalized.rankObservations]) {
    const membership = sourceMonth(row, runMap);
    if (!membership || !text(membership.keyword)) continue;
    const entry = descriptors.get(membership.keyword) || { keyword: membership.keyword, stay: new Set(), inventory: new Set(), ranks: new Set() };
    if (membership.inventoryMonth) { entry.stay.add(membership.inventoryMonth); entry.inventory.add(membership.inventoryMonth); }
    if (membership.rankMonth) { entry.stay.add(membership.rankMonth); entry.ranks.add(membership.rankMonth); }
    descriptors.set(entry.keyword, entry);
  }
  const publications = [];
  const keywords = [...descriptors.values()].filter(entry => entry.stay.size).sort((a, b) => a.keyword.localeCompare(b.keyword)).map(entry => {
    if (provenance.observationScope === "selected_only" && [...entry.stay].some(value => !date(provenance.selectionCutoffs[value]))) throw fault("KEYWORD_MONTHLY_SELECTION_CUTOFF_REQUIRED");
    const keywordRuns = normalized.runs.filter(run => run.keyword === entry.keyword);
    const ordered = keywordRuns.filter(run => attemptTime(run)).sort((a, b) => Date.parse(attemptTime(a)) - Date.parse(attemptTime(b)) || runId(a).localeCompare(runId(b)));
    const latest = attempt(ordered.at(-1));
    const lastSuccessful = attempt(ordered.filter(run => ["complete", "reused", "partial"].includes(status(run))).at(-1));
    const scopes = [...entry.stay].sort().map(value => {
      const months = new Set([value, priorMonth(value)]);
      const keep = row => {
        const run = runMap.get(String(row.runId || ""));
        if (String(row.keyword || run?.keyword || "") !== entry.keyword) return false;
        return months.has(String(row.stayDate || row.date || "").slice(0, 7)) || iso(row.collectedAt || run?.collectedAt) && months.has(kstDay(row.collectedAt || run.collectedAt).slice(0, 7));
      };
      const observations = normalized.observations.filter(keep), rankObservations = normalized.rankObservations.filter(keep);
      const savedProductRecoveries = normalized.savedProductRecoveries.filter(entry => keep(entry.row));
      const allRows = [...observations, ...rankObservations, ...savedProductRecoveries.map(entry => entry.row)];
      const used = new Set(allRows.map(row => String(row.runId || "")));
      const ids = new Set(allRows.map(companyId));
      const compact = { companies: normalized.companies.filter(row => ids.has(companyId(row))), runs: normalized.runs.filter(row => used.has(runId(row))),
        observations, rankObservations, savedProductRecoveries, warnings: normalized.warnings,
        sourceDiagnostics: Object.fromEntries(Object.entries(normalized.sourceDiagnostics).filter(([key]) => !["runInventoryComplete", "intermediateObservationsComplete"].includes(key))),
        ...(normalized.specialDays ? { specialDays: normalized.specialDays } : {}) };
      const scope = scopeKey(entry.keyword, value);
      const envelope = { schemaVersion: 1, calculationVersion: VERSION, scopeKey: scope, keyword: entry.keyword, month: value,
        sourceFingerprint, provenance, source: compact, sourceDigest: digest(JSON.stringify(compact)) };
      const bytes = Buffer.from(JSON.stringify(envelope));
      if (bytes.length > LIMITS.projectionBytes) throw fault("KEYWORD_MONTHLY_SIZE_LIMIT");
      publications.push({ name: `${scope}.json`, bytes });
      return { month: value, scopeKey: scope, sha256: digest(bytes), bytes: bytes.length };
    });
    return { keyword: entry.keyword, stayMonths: [...entry.stay].sort(), inventoryStayMonths: [...entry.inventory].sort(), rankMonths: [...entry.ranks].sort(),
      collectionMonths: [...new Set(keywordRuns.filter(run => iso(run.collectedAt) && run.collectedAtSource !== "filesystem").map(run => kstDay(run.collectedAt).slice(0, 7)))].sort(),
      activity: activityFor(keywordRuns, provenance.runInventoryComplete), latestAttempt: latest, lastSuccessfulAttempt: lastSuccessful, scopes };
  });
  if (publications.length > LIMITS.scopes) throw fault("KEYWORD_MONTHLY_SIZE_LIMIT");
  const index = { schemaVersion: 1, calculationVersion: VERSION, sourceFingerprint, provenance, keywords };
  const indexBytes = Buffer.from(JSON.stringify(index));
  if (indexBytes.length > LIMITS.indexBytes) throw fault("KEYWORD_MONTHLY_SIZE_LIMIT");
  const directory = path.resolve(outputDir);
  await checkPath(path.dirname(directory), true);
  // An existing directory is never updated or reused. Publish index last so a
  // partially written new projection cannot masquerade as a complete release.
  await fs.mkdir(directory);
  await fs.mkdir(path.join(directory, "projections"));
  for (const publication of publications) await fs.writeFile(path.join(directory, "projections", publication.name), publication.bytes, { flag: "wx" });
  await fs.writeFile(path.join(directory, "index.json"), indexBytes, { flag: "wx" });
  return { schemaVersion: 1, projectionDir: directory, indexSha256: digest(indexBytes), sourceFingerprint,
    keywordCount: keywords.length, scopeCount: publications.length, provenance };
}

function validateIndex(value) {
  const exact = (object, allowed) => plain(object) && Object.keys(object).every(key => allowed.includes(key));
  const monthsValid = values => Array.isArray(values) && values.length <= 1200 && values.every(month) && new Set(values).size === values.length;
  const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
  const attemptValid = value => value === null || exact(value, ["status", "observedAt", "errorCode"])
    && /^[a-z][a-z_]{0,40}$/.test(value.status || "") && (value.observedAt === null || iso(value.observedAt)) && (value.errorCode === null || safeCode(value.errorCode));
  if (!plain(value) || value.schemaVersion !== 1 || value.calculationVersion !== VERSION || !SHA.test(value.sourceFingerprint || "")
    || !exact(value, ["schemaVersion", "calculationVersion", "sourceFingerprint", "provenance", "keywords"])
    || !plain(value.provenance) || value.provenance.inputSha256 !== value.sourceFingerprint || !iso(value.provenance.materializedAt) || !iso(value.provenance.dataThrough)
    || Date.parse(value.provenance.dataThrough) > Date.parse(value.provenance.materializedAt)
    || !exact(value.provenance, ["inputSha256", "materializedAt", "dataThrough", "originalFreshnessVerified", "basis", "networkAttempted", "contextIncluded", "inputBytes", "copiedAt", "observationScope", "intermediateObservationsComplete", "runInventoryComplete", "selectionCutoffs"])
    || !["selected_only", "normalized_multirun", "verified_history_subset", "unspecified"].includes(value.provenance.observationScope)
    || typeof value.provenance.intermediateObservationsComplete !== "boolean" || typeof value.provenance.runInventoryComplete !== "boolean"
    || !plain(value.provenance.selectionCutoffs) || Object.keys(value.provenance.selectionCutoffs).length > 1200
    || Object.entries(value.provenance.selectionCutoffs).some(([key, cutoff]) => !month(key) || !date(cutoff) || cutoff > kstDay(value.provenance.materializedAt))
    || value.provenance.basis !== "explicit_offline_normalized_source_copy" || value.provenance.inputBytes !== undefined && !nonnegative(value.provenance.inputBytes)
    || value.provenance.copiedAt !== undefined && !iso(value.provenance.copiedAt)
    || value.provenance.networkAttempted !== false || value.provenance.contextIncluded !== false || value.provenance.originalFreshnessVerified !== false
    || !Array.isArray(value.keywords) || value.keywords.length > LIMITS.scopes) throw fault("KEYWORD_MONTHLY_INVALID_INDEX");
  let count = 0; const seen = new Set();
  for (const item of value.keywords) {
    if (!exact(item, ["keyword", "stayMonths", "inventoryStayMonths", "rankMonths", "collectionMonths", "activity", "latestAttempt", "lastSuccessfulAttempt", "scopes"])
      || !text(item.keyword) || seen.has(item.keyword) || !Array.isArray(item.scopes) || !monthsValid(item.stayMonths) || !monthsValid(item.collectionMonths)
      || !monthsValid(item.inventoryStayMonths) || !monthsValid(item.rankMonths) || [...item.inventoryStayMonths, ...item.rankMonths].some(value => !item.stayMonths.includes(value))
      || !attemptValid(item.latestAttempt) || !attemptValid(item.lastSuccessfulAttempt)
      || !exact(item.activity, ["basis", "rows", "unknownTimeRunCount", "coverageBasis", "counterScope", "runInventoryComplete"])
      || item.activity.basis !== "collection_month" || item.activity.coverageBasis !== "provided_unique_run_set" || item.activity.counterScope !== "provided_runs_only"
      || item.activity.runInventoryComplete !== value.provenance.runInventoryComplete || !Array.isArray(item.activity.rows)
      || !nonnegative(item.activity.unknownTimeRunCount) || item.activity.rows.length > 1200) throw fault("KEYWORD_MONTHLY_INVALID_INDEX");
    const activityMonths = new Set();
    for (const row of item.activity.rows) {
      const counts = ["freshRunCount", "reusedRunCount", "failedRunCount", "partialRunCount", "unknownRunCount"];
      if (!exact(row, ["month", "runCount", ...counts]) || !month(row.month) || activityMonths.has(row.month) || !item.collectionMonths.includes(row.month)
        || !nonnegative(row.runCount) || counts.some(key => !nonnegative(row[key])) || counts.reduce((sum, key) => sum + row[key], 0) !== row.runCount) throw fault("KEYWORD_MONTHLY_INVALID_INDEX");
      activityMonths.add(row.month);
    }
    if (activityMonths.size !== item.collectionMonths.length) throw fault("KEYWORD_MONTHLY_INVALID_INDEX");
    seen.add(item.keyword); const months = new Set();
    for (const scope of item.scopes) {
      if (!exact(scope, ["month", "scopeKey", "sha256", "bytes"]) || !month(scope.month) || months.has(scope.month) || !item.stayMonths.includes(scope.month) || scope.scopeKey !== scopeKey(item.keyword, scope.month)
        || !SHA.test(scope.sha256 || "") || !Number.isSafeInteger(scope.bytes) || scope.bytes < 1 || scope.bytes > LIMITS.projectionBytes) throw fault("KEYWORD_MONTHLY_INVALID_INDEX");
      months.add(scope.month); count += 1;
    }
    if (months.size !== item.stayMonths.length) throw fault("KEYWORD_MONTHLY_INVALID_INDEX");
    if (value.provenance.observationScope === "selected_only" && item.stayMonths.some(valueMonth => !date(value.provenance.selectionCutoffs[valueMonth]))) throw fault("KEYWORD_MONTHLY_INVALID_INDEX");
  }
  if (count > LIMITS.scopes) throw fault("KEYWORD_MONTHLY_INVALID_INDEX");
  return value;
}
function publicSnapshot(snapshot) {
  const evidence = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key))
    .filter(key => value[key] === null || typeof value[key] === "boolean" || typeof value[key] === "number" && Number.isFinite(value[key])
      || typeof value[key] === "string" && value[key].length <= 300 && !/[\u0000-\u001f\u007f\\/]/.test(value[key]))
    .map(key => [key, value[key]]));
  const cleanRow = row => {
    const safe = { ...row };
    const nested = (key, fields) => { if (Object.hasOwn(safe, key)) safe[key] = plain(safe[key]) ? evidence(safe[key], fields) : null; };
    nested("capacityBasis", ["count", "source"]);
    nested("sourceRecovery", RECOVERY_KEYS);
    nested("phoneValuation", ["policy", "quantityPolicy", "roundingPolicy", "unroundedRevenue", "completePriceCoverage"]);
    if (Array.isArray(safe.phonePriceEstimates)) safe.phonePriceEstimates = safe.phonePriceEstimates.slice(0, 1000).filter(plain)
      .map(value => evidence(value, ["productKey", "quantity", "unitPrice", "source", "sourceDate", "quantitySource", "estimatedQuantity"]));
    else if (Object.hasOwn(safe, "phonePriceEstimates")) safe.phonePriceEstimates = [];
    if (Array.isArray(safe.capacityWitnesses)) safe.capacityWitnesses = safe.capacityWitnesses.slice(0, 1000).filter(plain)
      .map(value => evidence(value, ["productKey", "count", "source", "runId", "sourceDate", "observedAt"]));
    else if (Object.hasOwn(safe, "capacityWitnesses")) safe.capacityWitnesses = [];
    if (plain(safe.sharedDayUseEvidence)) {
      const groups = safe.sharedDayUseEvidence.groups;
      safe.sharedDayUseEvidence = evidence(safe.sharedDayUseEvidence, ["policy", "publicSessions", "physicalRoomBookings", "excludedBookings"]);
      if (Array.isArray(groups)) safe.sharedDayUseEvidence.groups = groups.slice(0, 1000).filter(plain)
        .map(value => ({ ...evidence(value, ["groupKey", "lunchBookings", "dinnerBookings", "physicalRoomBookings", "reusedBookings", "classificationSource"]),
          ...(Array.isArray(value.productIds) ? { productIds: value.productIds.filter(item => typeof item === "string" && /^[A-Za-z0-9_.:-]{1,180}$/.test(item)).slice(0, 1000) } : {}) }));
    } else if (Object.hasOwn(safe, "sharedDayUseEvidence")) safe.sharedDayUseEvidence = null;
    return safe;
  };
  snapshot.sources.observations = snapshot.sources.observations.map(cleanRow);
  for (const comparison of Object.values(snapshot.comparisonByProduct || {})) {
    if (comparison?.previousSources?.observations) comparison.previousSources.observations = comparison.previousSources.observations.map(cleanRow);
  }
  return snapshot;
}
function validateRequest(input, today) {
  if (!plain(input) || Object.keys(input).some(key => !["keyword", "month", "cutoffDate"].includes(key))
    || !text(input.keyword) || !month(input.month) || input.cutoffDate !== undefined && !date(input.cutoffDate)) throw fault("KEYWORD_MONTHLY_INVALID_REQUEST", 400);
  const cutoffDate = input.cutoffDate ?? [today, lastDay(input.month)].sort()[0];
  if (cutoffDate > today) throw fault("KEYWORD_MONTHLY_FUTURE_CUTOFF", 400);
  return { keyword: input.keyword, month: input.month, cutoffDate };
}
function defaultCutoff(value, valueMonth, today) {
  return value.provenance.observationScope === "selected_only" && value.provenance.selectionCutoffs[valueMonth]
    || [today, lastDay(valueMonth), kstDay(value.provenance.dataThrough)].sort()[0];
}
function createKeywordMonthlyAnalysis({ projectionDir, now = () => Date.now(), staleAfterMs = DAY } = {}) {
  if (!text(projectionDir, 4000) || !Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new TypeError("A projection directory and finite freshness interval are required");
  const directory = path.resolve(projectionDir), indexFile = path.join(directory, "index.json");
  const basic = () => ({ schemaVersion: 1, readOnly: true, networkAttempted: false, currentDay: kstDay(nowIso(now)), currentMonth: kstDay(nowIso(now)).slice(0, 7) });
  async function index() { const read = await readJson(indexFile, LIMITS.indexBytes); validateIndex(read.value); return read; }
  function freshness(value) {
    const elapsed = Date.parse(nowIso(now)) - Date.parse(value.provenance.materializedAt);
    if (elapsed < -60000) throw fault("KEYWORD_MONTHLY_FUTURE_PROJECTION");
    return elapsed > staleAfterMs ? ["PROJECTION_EXPIRED"] : [];
  }
  function absent(error, request = null) {
    const missing = error.code === "ENOENT";
    return { ...basic(), status: missing ? "missing" : "needs_verification", ...(request ? { request, snapshot: null } : { keywords: [] }),
      activity: null, latestAttempt: null, lastSuccessfulAttempt: null, provenance: null,
      diagnostics: [missing ? "PROJECTION_NOT_PREPARED" : safeCode(error.code) || "KEYWORD_MONTHLY_READ_UNAVAILABLE"] };
  }
  async function options() {
    try {
      const read = await index(), value = read.value, diagnostics = freshness(value);
      return { ...basic(), status: diagnostics.length ? "stale" : "available", keywords: value.keywords.map(item => ({ keyword: item.keyword,
        stayMonths: item.stayMonths, collectionMonths: item.collectionMonths, inventoryStayMonths: item.inventoryStayMonths, rankMonths: item.rankMonths,
        defaultCutoffs: Object.fromEntries(item.stayMonths.map(valueMonth => [valueMonth, defaultCutoff(value, valueMonth, kstDay(nowIso(now)))])),
        supportedCutoffs: value.provenance.observationScope === "selected_only" ? Object.fromEntries(item.stayMonths.map(valueMonth => [valueMonth, value.provenance.selectionCutoffs[valueMonth]])) : null })),
        provenance: { ...value.provenance, indexSha256: read.sha256 }, diagnostics };
    } catch (error) { return absent(error); }
  }
  async function analyze(input) {
    const request = validateRequest(input, kstDay(nowIso(now)));
    let declared = false;
    try {
      const before = await index(), value = before.value;
      declared = true;
      const item = value.keywords.find(row => row.keyword === request.keyword), scope = item?.scopes.find(row => row.month === request.month);
      if (input.cutoffDate === undefined) request.cutoffDate = defaultCutoff(value, request.month, kstDay(nowIso(now)));
      if (!scope) return { ...basic(), status: "missing", request, snapshot: null, activity: item?.activity || null,
        latestAttempt: item?.latestAttempt || null, lastSuccessfulAttempt: null,
        provenance: { ...value.provenance, indexSha256: before.sha256 }, diagnostics: [item ? "MONTH_NOT_OBSERVED" : "KEYWORD_NOT_OBSERVED"] };
      if (value.provenance.observationScope === "selected_only" && request.cutoffDate !== value.provenance.selectionCutoffs[request.month]) {
        return { ...basic(), status: "missing", request, snapshot: null, supportedCutoffDate: value.provenance.selectionCutoffs[request.month], activity: item.activity,
          latestAttempt: item.latestAttempt, lastSuccessfulAttempt: null, provenance: { ...value.provenance, indexSha256: before.sha256 }, diagnostics: ["CUTOFF_NOT_RECONSTRUCTIBLE"] };
      }
      let projection;
      try { projection = await readJson(path.join(directory, "projections", `${scope.scopeKey}.json`), LIMITS.projectionBytes); }
      catch (error) { if (error.code === "ENOENT") throw fault("KEYWORD_MONTHLY_DECLARED_PROJECTION_MISSING"); throw error; }
      const envelope = projection.value;
      if (projection.sha256 !== scope.sha256 || projection.bytes !== scope.bytes || !plain(envelope) || envelope.schemaVersion !== 1
        || envelope.calculationVersion !== VERSION || envelope.scopeKey !== scope.scopeKey || envelope.keyword !== request.keyword || envelope.month !== request.month
        || envelope.sourceFingerprint !== value.sourceFingerprint || JSON.stringify(envelope.provenance) !== JSON.stringify(value.provenance)
        || digest(JSON.stringify(envelope.source)) !== envelope.sourceDigest) throw fault("KEYWORD_MONTHLY_PROJECTION_MISMATCH");
      const source = normalizeSource(envelope.source);
      if (JSON.stringify(source) !== JSON.stringify(envelope.source)) throw fault("KEYWORD_MONTHLY_UNEXPECTED_PROJECTION_FIELDS");
      const at = nowIso(now), engineRequest = { type: "keyword", targetId: request.keyword, month: request.month, cutoffDate: request.cutoffDate };
      const snapshot = buildMonthlyReportSnapshot(engineRequest, source, at);
      const previousRequest = previousMonthlyReportRequest(engineRequest);
      const previousCutoffSupported = value.provenance.observationScope !== "selected_only" || previousRequest.cutoffDate === value.provenance.selectionCutoffs[previousRequest.month];
      const previous = previousCutoffSupported ? buildMonthlyReportSnapshot(previousRequest, source, at) : null;
      snapshot.comparisonByProduct = Object.fromEntries(["lodging", "dayuse"].map(productType => [productType,
        previous && snapshot.sources.observations.some(row => row.productType === productType) && previous.sources.observations.some(row => row.productType === productType)
          ? buildMonthlyComparison(snapshot, previous, { productType }) : null]));
      snapshot.comparison = snapshot.comparisonByProduct.lodging;
      const latestValid = [...snapshot.sources.observations].sort((a, b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt) || a.runId.localeCompare(b.runId)).at(-1);
      const lastSuccessfulAttempt = latestValid ? { status: latestValid.runQuality, observedAt: latestValid.collectedAt, errorCode: null } : null;
      const diagnostics = freshness(value);
      if (value.provenance.observationScope !== "selected_only" && request.cutoffDate > kstDay(value.provenance.dataThrough)) diagnostics.push("CUTOFF_AFTER_DATA_THROUGH");
      if (!value.provenance.intermediateObservationsComplete) diagnostics.push("INTERMEDIATE_OBSERVATION_SET_INCOMPLETE");
      if (!previousCutoffSupported) diagnostics.push("PREVIOUS_CUTOFF_NOT_RECONSTRUCTIBLE");
      if (!snapshot.comparison) diagnostics.push("PREVIOUS_LODGING_MONTH_NOT_OBSERVED");
      if (!snapshot.comparisonByProduct.dayuse) diagnostics.push("PREVIOUS_DAYUSE_MONTH_NOT_OBSERVED");
      if (item.latestAttempt && !["complete", "reused", "partial"].includes(item.latestAttempt.status)) diagnostics.push("LATEST_ATTEMPT_FAILED_LAST_VALID_RETAINED");
      const after = await index();
      if (after.sha256 !== before.sha256) throw fault("KEYWORD_MONTHLY_EVIDENCE_CHANGED");
      if (!statSame(projection.stamp, await checkPath(path.join(directory, "projections", `${scope.scopeKey}.json`), false))) throw fault("KEYWORD_MONTHLY_EVIDENCE_CHANGED");
      return { ...basic(), status: diagnostics.some(code => ["PROJECTION_EXPIRED", "CUTOFF_AFTER_DATA_THROUGH"].includes(code)) ? "stale" : "available", request, snapshot: publicSnapshot(snapshot),
        activity: item.activity, latestAttempt: item.latestAttempt, lastSuccessfulAttempt,
        provenance: { ...value.provenance, indexSha256: before.sha256, projectionSha256: projection.sha256,
          sourceDigest: envelope.sourceDigest, calculationVersion: VERSION }, diagnostics };
    } catch (error) { return absent(declared && error.code === "ENOENT" ? fault("KEYWORD_MONTHLY_EVIDENCE_CHANGED") : error, request); }
  }
  return Object.freeze({ options, analyze });
}

module.exports = { createKeywordMonthlyAnalysis, buildKeywordMonthlyProjection, KEYWORD_MONTHLY_LIMITS: LIMITS };
