"use strict";

// Independent offline acceptance of a complete normalized public source copy.
// No application/context/catalog, provider, collector, queue or KOSIS imports.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { safeInput } = require("./build_keyword_monthly_projection.cjs");
const { buildKeywordMonthlyProjection, createKeywordMonthlyAnalysis, KEYWORD_MONTHLY_LIMITS } = require("./lib/keyword_monthly_analysis.cjs");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
const { buildMonthlyComparison, previousMonthlyReportRequest } = require("./lib/monthly_report_comparison.cjs");
const SHA = /^[a-f0-9]{64}$/;
const ARRAY_KEYS = ["companies", "runs", "observations", "rankObservations", "savedProductRecoveries"];
const PARTIAL_FIELDS = ["knownPartialRevenue", "knownPartialPublicRevenue", "knownPartialBlockedRevenue", "knownPartialCompanyDays"];
const FIELDS = ["summary", "daily", "companies", "selectedDigest", "partialEvidence", "comparison"];
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const companyId = row => String(row.companyId || row.id || row.companyKey || "");
const canonicalKey = row => [companyId(row), row.date || row.stayDate || "", row.productType === "day-use" ? "dayuse" : row.productType || ""].join("|");
const kstDay = value => new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10);
function fault(code) { return Object.assign(new Error(code), { code }); }
function requireValue(value, code) { if (!value) throw fault(code); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : canonical(item));
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
const fingerprint = value => digest(JSON.stringify(canonical(value === undefined ? null : value)));
const sortedRows = rows => [...(Array.isArray(rows) ? rows : [])].sort((a, b) => fingerprint(a).localeCompare(fingerprint(b)));
const multiset = rows => fingerprint((Array.isArray(rows) ? rows : []).map(fingerprint).sort());
const counts = source => Object.fromEntries(ARRAY_KEYS.map(key => [key, (source[key] || []).length]));
function comparisonCore(value) {
  if (!value) return null;
  const qualityFields = ["status", "provisional", "companyCount", "expectedCompanyDays", "coveredCompanyDays", "coverageRate", "missingCompanyDays", "sameDayObservedCompanyDays", "staleDays",
    "minObservationLeadTimeDays", "maxObservationLeadTimeDays", "medianObservationLeadTimeDays", "revenueCoveredCompanyDays", "revenueExcludedCompanyDays", "knownPartialCompanyDays", "recoveredCompanyDays"];
  return { previousMonth: value.previousMonth, currentMonth: value.currentMonth, previousCutoffDate: value.previousCutoffDate, currentCutoffDate: value.currentCutoffDate,
    status: value.status, all: value.all, common: value.common, newlyObservedCompanyIds: value.newlyObservedCompanyIds,
    noLongerObservedCompanyIds: value.noLongerObservedCompanyIds, sourceRunIds: value.sourceRunIds,
    previousQuality: Object.fromEntries(qualityFields.filter(key => Object.hasOwn(value.previousQuality || {}, key)).map(key => [key, value.previousQuality[key]])),
    previousSelectedDigest: value.previousSources?.digest ?? null, previousPartialEvidence: sortedRows(value.previousSources?.partialEvidence) };
}
function capture(snapshot) {
  requireValue(plain(snapshot) && plain(snapshot.summary) && Array.isArray(snapshot.daily) && Array.isArray(snapshot.companies)
    && SHA.test(snapshot.sources?.digest || "") && Array.isArray(snapshot.sources.partialEvidence), "COMPLETE_COPY_SNAPSHOT_FIELDS_REQUIRED");
  return { summary: snapshot.summary, daily: [...snapshot.daily].sort((a, b) => a.date.localeCompare(b.date)),
    companies: [...snapshot.companies].sort((a, b) => companyId(a).localeCompare(companyId(b))).map(row => ({ companyId: companyId(row), summary: row.summary, daily: [...(row.daily || [])].sort((a, b) => a.date.localeCompare(b.date)) })),
    selectedDigest: snapshot.sources.digest, partialEvidence: sortedRows(snapshot.sources.partialEvidence), comparison: comparisonCore(snapshot.comparison) };
}
function fingerprints(snapshot) {
  const core = capture(snapshot);
  return Object.fromEntries(FIELDS.map(key => [key, key === "selectedDigest" ? core[key] : fingerprint(core[key])]));
}
function checkRecord(checks, name, passed, details = {}) { const result = { name, passed: passed === true, ...details }; checks.push(result); return result.passed; }
function compareFields(checks, name, actual, expected) {
  const differences = FIELDS.filter(key => actual[key] !== expected[key]);
  return checkRecord(checks, name, differences.length === 0, { fields: Object.fromEntries(FIELDS.map(key => [key, { equal: actual[key] === expected[key], actualSha256: actual[key], expectedSha256: expected[key] }])), differences });
}
function partialAccounting(snapshot) {
  const rows = snapshot.sources?.partialEvidence || [], included = rows.filter(row => row.includedInPartialSubtotal === true), failures = [];
  const keys = included.map(canonicalKey); if (new Set(keys).size !== keys.length) failures.push({ scope: "included_partial_keys", reason: "duplicate_key" });
  const selectedKeys = new Set((snapshot.sources?.observations || []).map(canonicalKey));
  if (keys.some(key => selectedKeys.has(key))) failures.push({ scope: "included_partial_keys", reason: "overlaps_selected_normal_key" });
  function validate(metric, applicable, scope) {
    for (const field of PARTIAL_FIELDS) {
      const expected = field === "knownPartialCompanyDays" ? applicable.length : applicable.length ? applicable.reduce((sum, row) => sum + row[field], 0) : null;
      if (applicable.some(row => field !== "knownPartialCompanyDays" && (typeof row[field] !== "number" || !Number.isFinite(row[field]))) || metric?.[field] !== expected) failures.push({ scope, field, expectedSha256: fingerprint(expected), actualSha256: fingerprint(metric?.[field] ?? null) });
    }
  }
  for (const product of ["lodging", "dayuse"]) {
    validate(snapshot.summary?.[product], included.filter(row => row.productType === product), `summary:${product}`);
    for (const row of snapshot.daily || []) validate(row[product], included.filter(item => item.productType === product && item.date === row.date), `daily:${row.date}:${product}`);
    for (const company of snapshot.companies || []) {
      validate(company.summary?.[product], included.filter(item => item.productType === product && item.companyId === companyId(company)), `company:${companyId(company)}:${product}`);
      for (const row of company.daily || []) validate(row[product], included.filter(item => item.productType === product && item.companyId === companyId(company) && item.date === row.date), `company_daily:${companyId(company)}:${row.date}:${product}`);
    }
  }
  return { passed: failures.length === 0, basis: "independent_partial_evidence_to_aggregate_reconciliation_and_normal_key_disjointness", includedRows: included.length, excludedFromSubtotalRows: rows.length - included.length, includedMultisetSha256: multiset(included), failures };
}
function verifyCompleteness(source, sourceRead, manifest, canonicalMap, intermediateManifest) {
  const checks = [], actualCounts = counts(source), supplied = manifest.source || {};
  checkRecord(checks, "input_file_fingerprint", supplied.sha256 === sourceRead.sha256 && supplied.bytes === sourceRead.bytes, { actualSha256: sourceRead.sha256, expectedSha256: supplied.sha256 || null });
  checkRecord(checks, "original_and_public_array_counts", ARRAY_KEYS.every(key => Number.isSafeInteger(manifest.originalCounts?.[key])
    && manifest.originalCounts[key] === actualCounts[key] && manifest.publicCounts?.[key] === actualCounts[key]), { actualCounts, originalCounts: manifest.originalCounts || null, publicCounts: manifest.publicCounts || null });
  checkRecord(checks, "field_filter_drops_no_rows", manifest.fullness?.fieldFilterOnly === true && manifest.fullness?.excludedRows === 0);
  checkRecord(checks, "adapter_and_intermediate_completeness_declared", manifest.fullness?.normalizedAdapterComplete === true && manifest.fullness?.intermediateObservationsComplete === true);
  const rows = Array.isArray(canonicalMap) ? canonicalMap : canonicalMap?.entries;
  const mapValid = Array.isArray(rows) && rows.every(row => typeof row.sourceCompanyId === "string" && row.sourceCompanyId && typeof row.canonicalCompanyId === "string" && row.canonicalCompanyId);
  const pairs = mapValid ? rows.map(row => [row.sourceCompanyId, row.canonicalCompanyId]) : [];
  const mapped = new Map(); let conflicts = false;
  for (const [alias, canonicalId] of pairs) { if (mapped.has(alias) && mapped.get(alias) !== canonicalId) conflicts = true; mapped.set(alias, canonicalId); }
  const canonicalIds = [...new Set(pairs.map(([, value]) => value))].sort(), inputIds = [...new Set((source.companies || []).map(companyId))].sort();
  checkRecord(checks, "complete_canonical_map", mapValid && !conflicts && manifest.canonicalMap?.complete === true && manifest.canonicalMap.rows === pairs.length
    && manifest.canonicalMap.scope === "normalized_input_accepted_companies" && manifest.canonicalMap.acceptedCanonicalRows === inputIds.length
    && manifest.canonicalMap.uniqueSourceIds === mapped.size && manifest.canonicalMap.multisetSha256 === multiset(rows || [])
    && manifest.canonicalMap.inputCompanyIdsSha256 === fingerprint(inputIds) && inputIds.every(value => canonicalIds.includes(value))
    && manifest.canonicalMap.unresolvedAcceptedCount === 0 && manifest.canonicalMap.ambiguousAcceptedCount === 0,
    { scope: "all_accepted_companies_in_this_normalized_input", inputCompanies: inputIds.length, mapRows: pairs.length, uniqueSourceIds: mapped.size, mappedCanonicalIds: canonicalIds.length, conflicts });
  checkRecord(checks, "raw_identity_rejections_preserved_separately", Number.isSafeInteger(manifest.canonicalMap?.rawRejectedIdentityCount)
    && manifest.canonicalMap.rawRejectedIdentityCount >= 0 && manifest.identityAccounting?.sourceExcludedIdentityCount === manifest.canonicalMap.rawRejectedIdentityCount,
    { rawRejectedIdentityCount: manifest.canonicalMap?.rawRejectedIdentityCount ?? null, sourceExcludedIdentityCount: manifest.identityAccounting?.sourceExcludedIdentityCount ?? null,
      meaning: "Explicitly excluded raw identities remain excluded; accepted-map completeness never means these raw rows were canonicalized." });
  const inventory = intermediateManifest?.arrays || {};
  for (const key of ["observations", "rankObservations", "savedProductRecoveries"]) {
    const expected = inventory[key];
    checkRecord(checks, `complete_intermediate_manifest:${key}`, intermediateManifest?.complete === true && expected?.originalCount === actualCounts[key]
      && expected?.publicCount === actualCounts[key] && expected?.multisetSha256 === multiset(source[key] || [])
      && expected?.excludedRows === 0, { actualCount: actualCounts[key], actualMultisetSha256: multiset(source[key] || []), expected: expected || null });
  }
  return { passed: checks.every(row => row.passed), checks };
}
function pureSnapshot(source, query, now) {
  const request = { type: "keyword", targetId: query.keyword, month: query.month, cutoffDate: query.cutoffDate };
  const metadata = require("./lib/keyword_monthly_analysis.cjs").sourceForKeywordMonthlyRequest;
  requireValue(!source.monthlySourceMetadata || typeof metadata === "function", "COMPLETE_COPY_MONTHLY_METADATA_HELPER_REQUIRED");
  const previousRequest = previousMonthlyReportRequest(request), forRequest = value => typeof metadata === "function" ? metadata(source, value) : source;
  const current = buildMonthlyReportSnapshot(request, forRequest(request), now), previous = buildMonthlyReportSnapshot(previousRequest, forRequest(previousRequest), now);
  current.comparisonByProduct = Object.fromEntries(["lodging", "dayuse"].map(productType => [productType,
    current.sources.observations.some(row => row.productType === productType) && previous.sources.observations.some(row => row.productType === productType)
      ? buildMonthlyComparison(current, previous, { productType }) : null]));
  current.comparison = current.comparisonByProduct.lodging;
  return current;
}
function referenceEntries(value) {
  const rows = Array.isArray(value) ? value : value?.entries;
  requireValue(Array.isArray(rows) && rows.length > 0 && rows.length <= 100, "COMPLETE_COPY_REFERENCE_ENTRIES_REQUIRED");
  return rows.map(row => {
    const request = row.request || row.snapshot?.request, keyword = row.keyword || request?.targetId;
    requireValue(request?.type === "keyword" && request.targetId === keyword && /^20\d{2}-\d{2}$/.test(request.month || "") && /^20\d{2}-\d{2}-\d{2}$/.test(request.cutoffDate || ""), "COMPLETE_COPY_REFERENCE_REQUEST");
    const expected = row.fingerprints || (row.snapshot ? fingerprints(row.snapshot) : null);
    requireValue(plain(expected) && FIELDS.every(key => SHA.test(expected[key] || "")), "COMPLETE_COPY_FULL_ISSUED_FIELDS_REQUIRED");
    requireValue(typeof row.reportId === "string" && /^mr_[a-f0-9-]{36}$/.test(row.reportId) && SHA.test(row.snapshotHash || ""), "COMPLETE_COPY_ISSUED_PROVENANCE_REQUIRED");
    return { keyword, query: { keyword, month: request.month, cutoffDate: request.cutoffDate }, reportId: row.reportId, snapshotHash: row.snapshotHash, expected };
  });
}
function expectedReferences(manifest, references) {
  const expected = manifest.expectedIssuedScopes || manifest.declaredScopes;
  requireValue(Array.isArray(expected) && expected.length > 0 && expected.length <= 100, "COMPLETE_COPY_INDEPENDENT_EXPECTED_SCOPES_REQUIRED");
  const used = new Set();
  return expected.map(query => {
    const matches = references.filter(row => row.query.keyword === query.keyword && row.query.month === query.month && row.query.cutoffDate === query.cutoffDate);
    requireValue(matches.length === 1 && !used.has(JSON.stringify(matches[0].query)), "COMPLETE_COPY_EXPECTED_ISSUED_SCOPE_MISSING_OR_DUPLICATE");
    used.add(JSON.stringify(matches[0].query)); return matches[0];
  });
}
function verifyDeclaredOptionsScope(manifest, options) {
  const scope = manifest.sourceScope, valid = Array.isArray(scope?.keywords) && scope.keywords.length > 0 && Array.isArray(scope?.stayMonths) && scope.stayMonths.length > 0;
  const expected = valid ? scope.keywords.flatMap(keyword => scope.stayMonths.map(month => `${keyword}|${month}`)).sort() : [];
  const actual = (Array.isArray(options?.keywords) ? options.keywords : []).flatMap(row => (Array.isArray(row.stayMonths) ? row.stayMonths : []).map(month => `${row.keyword}|${month}`)).sort();
  return { passed: valid && new Set(expected).size === expected.length && fingerprint(expected) === fingerprint(actual), expectedScopePairs: expected, actualScopePairs: actual,
    meaning: "Only the independently declared keyword/stay-month scope may be advertised; leftover ranks from another month are not silently accepted." };
}
function verifyExtractionWitness(witness, sourceRead, referenceRead, manifest, references) {
  const checks = [];
  checkRecord(checks, "independent_extraction_fingerprint_chain", witness?.basis === "frozen_copy_exact_old_adapter_and_issued_export"
    && SHA.test(witness.rawFullSourceSha256 || "") && SHA.test(witness.sourceManifestSha256 || "") && SHA.test(witness.adapterCodeSha256 || "")
    && witness.publicSourceSha256 === sourceRead.sha256 && witness.referenceFileSha256 === referenceRead.sha256
    && fingerprint(witness.originalCounts) === fingerprint(manifest.originalCounts) && fingerprint(witness.publicCounts) === fingerprint(manifest.publicCounts)
    && witness.sourcePreserved === true && witness.providerCalls === 0 && witness.kosisCopied === 0,
    { basis: witness?.basis || null, rawFullSourceSha256: witness?.rawFullSourceSha256 || null, sourceManifestSha256: witness?.sourceManifestSha256 || null,
      adapterCodeSha256: witness?.adapterCodeSha256 || null, publicSourceSha256: sourceRead.sha256, referenceFileSha256: referenceRead.sha256 });
  for (const reference of references) {
    const matching = (Array.isArray(witness?.issuedExports) ? witness.issuedExports : []).filter(row => row.reportId === reference.reportId && row.snapshotHash === reference.snapshotHash);
    checkRecord(checks, "issued_reference_bound_to_frozen_export", matching.length === 1 && SHA.test(matching[0]?.reportFileSha256 || "")
      && matching[0]?.fingerprintsSha256 === fingerprint(reference.expected), { query: reference.query, reportId: reference.reportId, snapshotHash: reference.snapshotHash,
      frozenReportFileSha256: matching[0]?.reportFileSha256 || null, fingerprintsSha256: fingerprint(reference.expected) });
  }
  return { passed: checks.every(row => row.passed), checks };
}
function parseArgs(values) {
  const output = {}, allowed = new Set(["source", "manifest", "canonical-map", "intermediate-manifest", "extraction-witness", "reference", "replay", "output", "now", "data-through", "cutoffs"]);
  if (values.length === 1 && values[0] === "--help") return { help: true };
  for (let i = 0; i < values.length; i += 2) {
    const key = values[i]?.slice(2); requireValue(values[i]?.startsWith("--") && allowed.has(key) && !Object.hasOwn(output, key) && values[i + 1] && !values[i + 1].startsWith("--"), "COMPLETE_COPY_ARGUMENTS"); output[key] = values[i + 1];
  }
  for (const key of ["source", "manifest", "reference", "output", "now", "data-through"]) requireValue(output[key], "COMPLETE_COPY_REQUIRED_ARGUMENTS");
  for (const key of ["source", "manifest", "canonical-map", "intermediate-manifest", "extraction-witness", "reference", "replay", "output"]) if (output[key]) { requireValue(path.isAbsolute(output[key]), "COMPLETE_COPY_ABSOLUTE_PATH_REQUIRED"); output[key] = path.resolve(output[key]); }
  for (const key of ["now", "data-through"]) requireValue(/^20\d{2}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(output[key]) && Number.isFinite(Date.parse(output[key])), "COMPLETE_COPY_FIXED_CLOCK_REQUIRED");
  requireValue(Date.parse(output["data-through"]) <= Date.parse(output.now), "COMPLETE_COPY_DATA_THROUGH_AFTER_CLOCK");
  if (output.cutoffs) requireValue(output.cutoffs.split(",").length <= 20 && output.cutoffs.split(",").every(day => /^20\d{2}-\d{2}-\d{2}$/.test(day)
    && Number.isFinite(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day && day <= kstDay(output.now)), "COMPLETE_COPY_CUTOFFS");
  return output;
}
const USAGE = "node scripts/validate_keyword_monthly_complete_realcopy.cjs --source <absolute JSON> --manifest <absolute completeness JSON> --reference <absolute issued fingerprints JSON> --output <new absolute directory> --now <fixed ISO> --data-through <ISO> [--canonical-map <absolute JSON>] [--intermediate-manifest <absolute JSON>] [--extraction-witness <absolute JSON>] [--replay <previous limited replay JSON>] [--cutoffs YYYY-MM-DD,YYYY-MM-DD]";
async function read(file, inputs) {
  const result = await safeInput(file, 64 * 1024 * 1024), output = { file: result.file, bytes: result.bytes.length, sha256: digest(result.bytes), value: JSON.parse(result.bytes.toString("utf8")) };
  inputs.push(output); return output;
}
async function attached(explicit, descriptor, base, inputs) {
  if (explicit) return read(explicit, inputs);
  if (descriptor?.entries || descriptor?.arrays || descriptor?.basis) return { value: descriptor };
  requireValue(typeof descriptor?.file === "string" && /^[A-Za-z0-9_.-]+\.json$/.test(descriptor.file), "COMPLETE_COPY_MANIFEST_ATTACHMENT_REQUIRED");
  return read(path.join(base, descriptor.file), inputs);
}
async function tree(directory) {
  const files = [];
  const walk = async current => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name); requireValue(!entry.isSymbolicLink(), "COMPLETE_COPY_UNSAFE_OUTPUT");
      if (entry.isDirectory()) await walk(file); else { const result = await safeInput(file, KEYWORD_MONTHLY_LIMITS.projectionBytes); files.push({ file: path.relative(directory, file).replace(/\\/g, "/"), bytes: result.bytes.length, sha256: digest(result.bytes) }); }
    }
  };
  await walk(directory); return files.sort((a, b) => a.file.localeCompare(b.file));
}
function networkGuard() {
  let attempts = 0; const kinds = [], restore = [];
  const block = kind => () => { attempts++; if (kinds.length < 30) kinds.push(kind); throw fault("COMPLETE_COPY_OUTBOUND_BLOCKED"); };
  function patch(object, key, label) { if (typeof object[key] !== "function") return; const original = object[key]; object[key] = block(label || key); restore.push(() => { object[key] = original; }); }
  patch(globalThis, "fetch"); patch(globalThis, "WebSocket");
  for (const module of ["node:http", "node:https"]) for (const key of ["request", "get"]) patch(require(module), key, `${module}.${key}`);
  const net = require("node:net"); for (const key of ["connect", "createConnection"]) patch(net, key, `net.${key}`); patch(net.Socket.prototype, "connect", "net.Socket.connect");
  patch(require("node:tls"), "connect", "tls.connect"); patch(require("node:http2"), "connect", "http2.connect");
  for (const key of ["exec", "execFile", "spawn", "fork", "execSync", "execFileSync", "spawnSync"]) patch(require("node:child_process"), key, `child_process.${key}`);
  return { state: () => ({ attempts, blockedKinds: kinds }), restore() { for (const fn of restore.reverse()) fn(); } };
}
async function readOnly(operation, state) {
  const originals = {};
  for (const key of ["writeFile", "appendFile", "mkdir", "rename", "copyFile", "cp", "rm", "rmdir", "unlink", "truncate", "chmod", "chown", "utimes", "link", "symlink"]) if (typeof fs[key] === "function") {
    originals[key] = fs[key]; fs[key] = async () => { state.writeAttempts++; throw fault("COMPLETE_COPY_RUNTIME_WRITE_BLOCKED"); };
  }
  try { return await operation(); } finally { Object.assign(fs, originals); }
}
async function publish(source, sourceFingerprint, directory, now, through) {
  await buildKeywordMonthlyProjection({ source, sourceFingerprint, outputDir: directory,
    sourceProvenance: { observationScope: "normalized_multirun" }, materializedAt: now, dataThrough: through, now: () => now });
  return createKeywordMonthlyAnalysis({ projectionDir: directory, now: () => now });
}
function cutoffQueries(source, baseQueries, manual, now) {
  const queries = new Map(), runKeywords = new Map((source.runs || []).map(row => [String(row.id || row.runId || ""), row.keyword]));
  for (const base of baseQueries) {
    const days = [...new Set((source.observations || []).filter(row => (row.keyword || runKeywords.get(String(row.runId || ""))) === base.keyword && String(row.stayDate || row.date || "").startsWith(`${base.month}-`))
      .map(row => row.collectedAt).filter(value => typeof value === "string" && Number.isFinite(Date.parse(value))).map(kstDay).filter(value => value <= base.cutoffDate))].sort();
    const chosen = manual ? manual.split(",").filter(value => value <= base.cutoffDate && value <= kstDay(now)) : [days[0], days[Math.floor(days.length / 2)], days.at(-1), base.cutoffDate].filter(Boolean);
    for (const cutoffDate of [...new Set(chosen)].sort()) { const query = { ...base, cutoffDate }; queries.set(JSON.stringify(query), query); }
  }
  return [...queries.values()];
}
function falsifiedSource(source, originals, kind, now, through) {
  const value = clone(source), additions = [], runKeywords = new Map((source.runs || []).map(row => [String(row.id || row.runId || ""), row.keyword])); let last = Date.parse(through);
  for (const [index, original] of originals.entries()) {
    const boundary = Math.min(Date.parse(`${original.query.cutoffDate}T23:59:59.999+09:00`), Date.parse(now));
    let chosen = null;
    for (const row of original.snapshot.sources.observations) {
      const latestAllowed = Math.min(boundary, Date.parse(`${row.date}T23:59:59.999+09:00`));
      const times = [...(source.observations || []), ...(source.savedProductRecoveries || []).map(entry => entry.row)]
        .filter(item => canonicalKey(item) === canonicalKey(row) && (item.keyword || runKeywords.get(String(item.runId || ""))) === original.query.keyword)
        .map(item => Date.parse(item.collectedAt)).filter(time => Number.isFinite(time) && time <= latestAllowed);
      const observed = Math.max(Date.parse(row.collectedAt), ...times) + 1;
      if (observed <= latestAllowed) { chosen = { row, observed }; break; }
    }
    if (!chosen) continue;
    const { row, observed } = chosen, collectedAt = new Date(observed).toISOString(), runId = `acceptance-synthetic-${kind}-${index + 1}`;
    requireValue(!value.runs.some(run => (run.id || run.runId) === runId), "COMPLETE_COPY_SYNTHETIC_ID_COLLISION");
    value.runs.push({ id: runId, keyword: original.query.keyword, collectedAt, collectionQuality: { status: kind === "failed" ? "failed" : "complete" } });
    value.observations.push({ observationId: `${runId}:invalid`, companyId: row.companyId, runId, keyword: original.query.keyword, productType: row.productType,
      stayDate: row.date, collectedAt, inventoryEvidenceVersion: 4, missing: true, partial: true, supply: null, sold: null,
      publicBookings: null, phoneBookings: null, estimatedRevenue: null, publicRevenue: null, phoneRevenue: null });
    additions.push({ query: original.query, canonicalKeySha256: fingerprint(canonicalKey(row)), invalidRunId: runId, invalidObservedAt: collectedAt }); last = Math.max(last, observed);
  }
  return { source: value, additions, dataThrough: new Date(last).toISOString() };
}
async function main(values) {
  const config = parseArgs(values); if (config.help) { console.log(USAGE); return null; }
  const inputs = [], sourceRead = await read(config.source, inputs), manifestRead = await read(config.manifest, inputs), referenceRead = await read(config.reference, inputs);
  const source = sourceRead.value;
  requireValue(plain(source) && ARRAY_KEYS.every(key => source[key] === undefined && ["rankObservations", "savedProductRecoveries"].includes(key) || Array.isArray(source[key])), "COMPLETE_COPY_SOURCE_ARRAYS");
  const manifest = Array.isArray(manifestRead.value.entries) ? manifestRead.value.entries.find(row => row.source?.sha256 === sourceRead.sha256) : manifestRead.value;
  requireValue(plain(manifest), "COMPLETE_COPY_MANIFEST_SOURCE_NOT_FOUND");
  const mapRead = await attached(config["canonical-map"], manifest.canonicalMap, path.dirname(config.manifest), inputs);
  const intermediateRead = await attached(config["intermediate-manifest"], manifest.intermediateManifest, path.dirname(config.manifest), inputs);
  const witnessRead = await attached(config["extraction-witness"], manifest.extractionWitness, path.dirname(config.manifest), inputs);
  if (config.replay) await read(config.replay, inputs);
  const references = referenceEntries(referenceRead.value), relevant = expectedReferences(manifest, references);
  const output = config.output; requireValue(!inputs.some(row => row.file === output || row.file.startsWith(output + path.sep)), "COMPLETE_COPY_OUTPUT_CONTAINS_INPUT");
  await fs.mkdir(output, { recursive: false });
  const guard = networkGuard(), checks = [], state = { writeAttempts: 0 }, scopeResults = [], preparations = [], fixedNow = new Date(config.now).toISOString(), through = new Date(config["data-through"]).toISOString();
  try {
    const completeness = verifyCompleteness(source, sourceRead, manifest, mapRead.value, intermediateRead.value);
    checkRecord(checks, "source_completeness_acceptance", completeness.passed);
    const witness = verifyExtractionWitness(witnessRead.value, sourceRead, referenceRead, manifest, relevant);
    checkRecord(checks, "independent_extraction_and_issued_export_witness", witness.passed);
    checkRecord(checks, "extraction_witness_is_separately_frozen_file", Boolean(witnessRead.file));
    for (const [name, descriptor, readResult] of [["canonical_map", manifest.canonicalMap, mapRead], ["intermediate_manifest", manifest.intermediateManifest, intermediateRead], ["extraction_witness", manifest.extractionWitness, witnessRead]]) {
      if (readResult.file) checkRecord(checks, `${name}_attachment_fingerprint`, descriptor?.fileSha256 === readResult.sha256 && descriptor?.fileBytes === readResult.bytes);
    }
    const projectionDir = path.join(output, "projection-complete-source"), service = await publish(source, sourceRead.sha256, projectionDir, fixedNow, through), before = await tree(projectionDir);
    preparations.push({ kind: "actual_complete_public_source_copy", projectionDir });
    const options = await readOnly(() => service.options(), state); checkRecord(checks, "read_only_options_available", options.status === "available");
    const optionsScope = verifyDeclaredOptionsScope(manifest, options); checkRecord(checks, "advertised_scope_matches_frozen_declared_scope", optionsScope.passed, optionsScope);
    const originals = [];
    for (const reference of relevant) {
      const result = await readOnly(() => service.analyze(reference.query), state);
      if (!checkRecord(checks, "issued_scope_available", result.status === "available" && result.snapshot !== null, { query: reference.query, diagnostics: result.diagnostics })) continue;
      const actual = fingerprints(result.snapshot), pure = pureSnapshot(source, reference.query, fixedNow), pureFields = fingerprints(pure), accounting = partialAccounting(result.snapshot);
      const issuedMatch = compareFields(checks, "frozen_issued_reference_parity", actual, reference.expected), pureMatch = compareFields(checks, "same_source_current_pure_engine_parity", actual, pureFields);
      checkRecord(checks, "partial_evidence_independent_accounting", accounting.passed, { query: reference.query, ...accounting });
      checkRecord(checks, "dayuse_same_source_comparison_parity", fingerprint(comparisonCore(result.snapshot.comparisonByProduct?.dayuse)) === fingerprint(comparisonCore(pure.comparisonByProduct?.dayuse)), { query: reference.query, originalIssuedDayuseComparison: "not_asserted_when_not_issued" });
      const repeated = await readOnly(() => service.analyze(reference.query), state); compareFields(checks, "repeated_get_is_not_accumulation", fingerprints(repeated.snapshot), actual);
      const selected = result.snapshot.sources.observations, selectedKeys = selected.map(canonicalKey);
      checkRecord(checks, "unique_selected_company_stay_product_keys", new Set(selectedKeys).size === selectedKeys.length, { query: reference.query, selectedKeys: selectedKeys.length });
      scopeResults.push({ query: reference.query, issuedReportId: reference.reportId, issuedSnapshotHash: reference.snapshotHash, issuedReferenceParity: issuedMatch, sameSourcePureParity: pureMatch, fingerprints: actual,
        partialAccounting: { passed: accounting.passed, includedRows: accounting.includedRows, excludedFromSubtotalRows: accounting.excludedFromSubtotalRows, includedMultisetSha256: accounting.includedMultisetSha256 } });
      originals.push({ query: reference.query, snapshot: result.snapshot });
    }
    const doubled = { ...source, observations: [...source.observations, ...source.observations], rankObservations: [...(source.rankObservations || []), ...(source.rankObservations || [])], savedProductRecoveries: [...(source.savedProductRecoveries || []), ...(source.savedProductRecoveries || [])] };
    preparations.push({ kind: "synthetic_duplicate_same_pure_engine_memory_only", projectionPublished: false, actualInputCounts: counts(source), doubledInputCounts: counts(doubled) });
    for (const original of originals) {
      const duplicate = pureSnapshot(doubled, original.query, fixedNow);
      compareFields(checks, "double_observations_pure_engine_no_double_totals", fingerprints(duplicate), fingerprints(original.snapshot));
      checkRecord(checks, "double_observations_pure_engine_dayuse_comparison_unchanged", fingerprint(comparisonCore(duplicate.comparisonByProduct?.dayuse)) === fingerprint(comparisonCore(original.snapshot.comparisonByProduct?.dayuse)), { query: original.query });
    }
    const accumulated = new Map(); let changedAcrossCutoffs = false;
    const fullPeriodQueries = relevant.flatMap(row => { const previous = previousMonthlyReportRequest({ type: "keyword", targetId: row.query.keyword, month: row.query.month, cutoffDate: row.query.cutoffDate });
      return [row.query, { keyword: previous.targetId, month: previous.month, cutoffDate: previous.cutoffDate }]; });
    for (const query of cutoffQueries(source, fullPeriodQueries, config.cutoffs, fixedNow)) {
      const result = await readOnly(() => service.analyze(query), state), pure = pureSnapshot(source, query, fixedNow);
      if (!checkRecord(checks, "multi_cutoff_available", result.status === "available" && result.snapshot !== null, { query })) continue;
      compareFields(checks, "multi_cutoff_same_source_current_pure", fingerprints(result.snapshot), fingerprints(pure));
      const prior = accumulated.get(`${query.keyword}|${query.month}`), selected = result.snapshot.sources.observations;
      checkRecord(checks, "cutoff_excludes_later_observations", selected.every(row => kstDay(row.collectedAt) <= query.cutoffDate && kstDay(row.collectedAt) <= row.date), { query });
      if (prior) {
        const byKey = new Map(selected.map(row => [canonicalKey(row), row]));
        checkRecord(checks, "later_cutoff_preserves_or_replaces_valid_keys", prior.rows.every(row => byKey.has(canonicalKey(row)) && Date.parse(byKey.get(canonicalKey(row)).collectedAt) >= Date.parse(row.collectedAt)), { query, previousCutoffDate: prior.query.cutoffDate });
        if (prior.digest !== result.snapshot.sources.digest || prior.partialDigest !== fingerprint(sortedRows(result.snapshot.sources.partialEvidence))) changedAcrossCutoffs = true;
      }
      accumulated.set(`${query.keyword}|${query.month}`, { query, rows: selected, digest: result.snapshot.sources.digest, partialDigest: fingerprint(sortedRows(result.snapshot.sources.partialEvidence)) });
    }
    checkRecord(checks, "actual_multi_cutoff_selected_or_partial_evidence_changes", changedAcrossCutoffs);
    for (const kind of ["missing", "failed"]) {
      const injected = falsifiedSource(source, originals, kind, fixedNow, through);
      checkRecord(checks, `latest_invalid_${kind}_falsification_applicable`, injected.additions.length === originals.length && injected.additions.length > 0);
      const directory = path.join(output, `projection-synthetic-latest-${kind}`), altered = await publish(injected.source, fingerprint(injected.source), directory, fixedNow, injected.dataThrough);
      preparations.push({ kind: `synthetic_latest_${kind}_falsification_only`, projectionDir: directory, injectedInvalidRows: injected.additions.length });
      for (const original of originals) {
        const result = await readOnly(() => altered.analyze(original.query), state);
        checkRecord(checks, `latest_invalid_${kind}_projection_available`, result.status === "available", { query: original.query });
        if (result.snapshot) compareFields(checks, `latest_invalid_${kind}_cannot_replace_last_valid`, fingerprints(result.snapshot), fingerprints(original.snapshot));
      }
    }
    checkRecord(checks, "runtime_projection_files_unchanged", fingerprint(await tree(projectionDir)) === fingerprint(before));
    for (const input of inputs) { const after = await safeInput(input.file, 64 * 1024 * 1024); checkRecord(checks, "input_file_unchanged", digest(after.bytes) === input.sha256 && after.bytes.length === input.bytes, { file: input.file, sha256: input.sha256 }); }
    checkRecord(checks, "no_runtime_write_attempts", state.writeAttempts === 0); checkRecord(checks, "no_outbound_network_attempts", guard.state().attempts === 0);
    const receipt = { schemaVersion: 1, status: checks.every(row => row.passed) && scopeResults.length === relevant.length ? "passed" : "needs_verification", purpose: "complete_normalized_public_source_copy_acceptance",
      observedAt: new Date().toISOString(), fixedNow, dataThrough: through, inputs: inputs.map(({ value, ...row }) => row), sourceCounts: counts(source), sourceCompleteness: completeness, extractionWitness: witness,
      frozenIssuedReferenceParity: scopeResults.every(row => row.issuedReferenceParity) && scopeResults.length === relevant.length,
      sameSourceCurrentPureParity: scopeResults.every(row => row.sameSourcePureParity) && scopeResults.length === relevant.length,
      scopes: scopeResults, checks, preparations, runtimeWriteAttempts: state.writeAttempts, network: guard.state(), productionAccess: 0, providerCalls: 0, kosisReadOrChanged: false,
      engineFingerprints: { monthly: digest(await fs.readFile(path.join(__dirname, "lib/monthly_reports.cjs"))), comparison: digest(await fs.readFile(path.join(__dirname, "lib/monthly_report_comparison.cjs"))) },
      limits: ["Completeness is checked against the isolated extraction manifest, complete canonical map and intermediate-row inventory; no production or raw live history is read.",
        "Current pure-engine consistency and frozen issued-report parity are separate acceptance results.", "Synthetic duplicate/invalid-latest sources are falsification cases only and are not actual collected history. The full doubled-source proof runs in the same pure engine in memory and is not published as an API projection; the API duplicate path is covered separately by small fixtures.",
        "Complete means all normalized observations in the frozen copy for its declared keywords and September/October scope; it does not mean a complete calendar month, a complete failed/unexecuted-run ledger or current production.",
        "Financial summary/daily/canonical-company/partial evidence and comparison semantics are compared; context, addresses, KOSIS and service metadata are outside this acceptance scope. No completeness flags are inserted into sourceDiagnostics.",
        "Increasing cutoffs may lower valid corrected reservations; only valid key retention and evidence chronology, not monotonically increasing sales, are asserted."] };
    await fs.writeFile(path.join(output, "complete-realcopy-validation.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ status: receipt.status, output, scopes: scopeResults.length, checks: checks.length, sourceCompleteness: completeness.passed, frozenIssuedReferenceParity: receipt.frozenIssuedReferenceParity, sameSourceCurrentPureParity: receipt.sameSourceCurrentPureParity }));
    return receipt;
  } finally { guard.restore(); }
}
if (require.main === module) main(process.argv.slice(2)).then(result => { if (result && result.status !== "passed") process.exitCode = 1; }).catch(error => {
  console.error(JSON.stringify({ code: /^[A-Z][A-Z0-9_]+$/.test(error.code || error.message || "") ? error.code || error.message : "COMPLETE_COPY_VALIDATION_FAILED" })); process.exitCode = 1;
});
module.exports = { canonical, fingerprint, multiset, counts, capture, fingerprints, comparisonCore, partialAccounting, verifyCompleteness, referenceEntries, expectedReferences, verifyDeclaredOptionsScope, verifyExtractionWitness, pureSnapshot, parseArgs, cutoffQueries, falsifiedSource, main };
