"use strict";
// Explicit preparation and immutable derived partitions only. No application,
// source adapter, collector, provider, queue, credentials or KOSIS dependency.
const fs = require("node:fs/promises");
const C = require("node:fs").constants;
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createKeywordMonthlyAnalysis, createKeywordMonthlyOptionsIndexReader, KEYWORD_MONTHLY_LIMITS: CHILD_LIMITS } = require("./keyword_monthly_analysis.cjs");
const { getAnalyticalPhaseDiagnostics } = require("./analytical_phase_runtime.cjs");
const { runKeywordMonthlyMemoryAdmission, keywordMonthlyAllocationCheckpoint } = require("./keyword_monthly_memory_admission.cjs");
const { keywordMonthlyGuardDiagnosticFromError } = require("./keyword_monthly_guard_diagnostics.cjs");
const { measureKeywordMonthlyMetadata } = require("./keyword_monthly_metadata_diagnostics.cjs");
const { calculationFingerprint, queryId, validatePreparedDescriptor, encodePreparedResult, decodePreparedResult,
  KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS: RESULT_LIMITS } = require("./keyword_monthly_prepared_results.cjs");
const measureDefault = async (phase, metadata, operation) => {
  await keywordMonthlyAllocationCheckpoint(phase);
  return getAnalyticalPhaseDiagnostics().measure(phase, metadata, operation);
};
const LIMITS = Object.freeze({ pointerBytes: 16384, catalogBytes: 1024 * 1024, optionsBytes: 2 * 1024 * 1024, partitions: 512, scopes: 4096, defaultTotalBytes: 1024 * 1024 * 1024 });
const SHA = /^[a-f0-9]{64}$/, GENERATION = /^[a-f0-9]{32}$/, MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const pathProofs = new WeakMap();
const sameStat = (a, b) => {
  if (!["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].every(key => a[key] === b[key])) return false;
  const left = pathProofs.get(a), right = pathProofs.get(b);
  // Directory siblings may be published while a stable file is read. Bind
  // ancestor identities and modes, not their unrelated mtime/link counts.
  return !left || !right || left.length === right.length && left.every((row, index) => row.file === right[index].file
    && ["dev", "ino", "mode"].every(key => row[key] === right[index][key]));
};
function boundedPathChecks(limit) {
  let active = 0; const pending = [];
  const drain = () => { while (active < limit && pending.length) {
    const { operation, resolve, reject } = pending.shift(); active++;
    Promise.resolve().then(operation).then(value => { active--; resolve(value); drain(); }, error => { active--; reject(error); drain(); });
  } };
  return operation => new Promise((resolve, reject) => { pending.push({ operation, resolve, reject }); drain(); });
}
const pathCheck = boundedPathChecks(8);
const keywordValid = value => typeof value === "string" && value.length > 0 && value.length <= 300 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const iso = value => typeof value === "string" && /^20\d{2}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))
  && new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);
const scopeId = (keyword, month) => JSON.stringify([keyword, month]);
const PREVALIDATION_KIND = "keyword_monthly_bundle_semantic_prevalidation_v1", PREVALIDATION_BYTES = 16 * 1024 * 1024;
const inputIdentity = inputs => hash(JSON.stringify(inputs.map(input => ({ directory: path.resolve(input.directory), ...(input.exposeScopes === undefined ? {} : { exposeScopes: input.exposeScopes }) }))));
function fault(code, statusCode = 503) { return Object.assign(new Error(code), { code, statusCode }); }
function ensure(value, code, statusCode = 503) { if (!value) throw fault(code, statusCode); }
async function checkPath(file, directory = false) {
  const absolute = path.resolve(file), root = path.parse(absolute).root, ancestors = []; let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); ancestors.push(current);
  }
  // Recheck every ancestor on every call. Only independent path pairs overlap;
  // each pair still performs lstat then realpath. All queued checks settle on
  // failure too, before the caller may open/parse a file or release its owner.
  const completed = await Promise.allSettled(ancestors.map(file => pathCheck(async () => {
    const stat = await fs.lstat(file);
    ensure(!stat.isSymbolicLink() && samePath(await fs.realpath(file), file) && (file === absolute || stat.isDirectory()), "KEYWORD_MONTHLY_BUNDLE_UNSAFE_PATH");
    return { file, stat };
  })));
  const failure = completed.find(result => result.status === "rejected"); if (failure) throw failure.reason;
  const stat = await pathCheck(()=>fs.lstat(absolute)); ensure(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, "KEYWORD_MONTHLY_BUNDLE_UNSAFE_PATH");
  if (completed.length) ensure(sameStat(completed.at(-1).value.stat, stat), "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ");
  pathProofs.set(stat, completed.slice(0, -1).map(({ value }) => ({ file: value.file, dev: value.stat.dev, ino: value.stat.ino, mode: value.stat.mode })));
  return stat;
}
async function readFile(file, maximum) {
  const before = await checkPath(file); ensure(before.size > 0 && before.size <= maximum, "KEYWORD_MONTHLY_BUNDLE_SIZE_LIMIT");
  const handle = await fs.open(file, C.O_RDONLY | (C.O_NOFOLLOW || 0));
  try {
    ensure(sameStat(before, await handle.stat()), "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ");
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    ensure(offset === before.size && sameStat(before, await handle.stat()) && sameStat(before, await checkPath(file)), "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ");
    const buffer = bytes.subarray(0, offset); return { file, bytes: buffer, size: buffer.length, sha256: hash(buffer), stamp: before };
  } finally { await handle.close(); }
}
async function exactDirectoryEntries(directory, expected, maximum) {
  const before = await checkPath(directory, true), entries = await fs.readdir(directory, { withFileTypes: true });
  ensure(entries.length <= maximum && entries.every(entry => !entry.isSymbolicLink())
    && JSON.stringify(entries.map(entry => entry.name).sort()) === JSON.stringify([...expected].sort())
    && sameStat(before, await checkPath(directory, true)), "KEYWORD_MONTHLY_BUNDLE_PREVALIDATION_READBACK_FAILED");
}
function json(read) { try { return JSON.parse(read.bytes.toString("utf8")); } catch { throw fault("KEYWORD_MONTHLY_BUNDLE_INVALID_JSON"); } }
function validatePointer(value) {
  ensure(exact(value, ["schemaVersion", "generation", "catalogSha256", "catalogBytes", "publishedAt"]) && value.schemaVersion === 1
    && GENERATION.test(value.generation) && SHA.test(value.catalogSha256) && Number.isSafeInteger(value.catalogBytes) && value.catalogBytes > 0 && value.catalogBytes <= LIMITS.catalogBytes && iso(value.publishedAt), "KEYWORD_MONTHLY_BUNDLE_INVALID_POINTER");
  return value;
}
function validateCatalog(value) {
  const resultFields = value?.schemaVersion === 2 ? ["preparedResults"] : [];
  ensure(exact(value, ["schemaVersion", "kind", "createdAt", "partitions", "scopes", ...resultFields]) && [1, 2].includes(value.schemaVersion) && value.kind === "keyword_monthly_partition_bundle" && iso(value.createdAt)
    && Array.isArray(value.partitions) && value.partitions.length > 0 && value.partitions.length <= LIMITS.partitions && Array.isArray(value.scopes) && value.scopes.length > 0 && value.scopes.length <= LIMITS.scopes, "KEYWORD_MONTHLY_BUNDLE_INVALID_CATALOG");
  const partitions = new Set(), scopes = new Set(), used = new Set();
  for (const part of value.partitions) {
    ensure(exact(part, ["key", "indexSha256", "indexBytes"]) && SHA.test(part.key) && part.key === part.indexSha256 && !partitions.has(part.key)
      && Number.isSafeInteger(part.indexBytes) && part.indexBytes > 0 && part.indexBytes <= CHILD_LIMITS.indexBytes, "KEYWORD_MONTHLY_BUNDLE_INVALID_CATALOG"); partitions.add(part.key);
  }
  for (const scope of value.scopes) {
    const id = scopeId(scope.keyword, scope.month);
    ensure(exact(scope, ["keyword", "month", "partition"]) && keywordValid(scope.keyword) && MONTH.test(scope.month) && partitions.has(scope.partition) && !scopes.has(id), "KEYWORD_MONTHLY_BUNDLE_SCOPE_CONFLICT");
    scopes.add(id); used.add(scope.partition);
  }
  ensure(used.size === partitions.size, "KEYWORD_MONTHLY_BUNDLE_UNUSED_PARTITION");
  if (value.schemaVersion === 2) {
    ensure(Array.isArray(value.preparedResults) && value.preparedResults.length > 0 && value.preparedResults.length <= RESULT_LIMITS.results, "KEYWORD_MONTHLY_RESULT_CATALOG_INVALID");
    const resultIds = new Set();
    for (const descriptor of value.preparedResults) {
      validatePreparedDescriptor(descriptor); const id = queryId(descriptor);
      ensure(!resultIds.has(id) && value.scopes.some(scope => scope.keyword === descriptor.keyword && scope.month === descriptor.month && scope.partition === descriptor.partition), "KEYWORD_MONTHLY_RESULT_SCOPE_CONFLICT");
      resultIds.add(id);
    }
  }
  return value;
}
async function loadBundle(directory) {
  const pointerRead = await readFile(path.join(directory, "current.json"), LIMITS.pointerBytes), pointer = validatePointer(json(pointerRead));
  const generationDir = path.join(directory, "generations", pointer.generation), catalogRead = await readFile(path.join(generationDir, "catalog.json"), LIMITS.catalogBytes);
  ensure(catalogRead.sha256 === pointer.catalogSha256 && catalogRead.size === pointer.catalogBytes, "KEYWORD_MONTHLY_BUNDLE_CATALOG_MISMATCH");
  return { pointerRead, pointer, generationDir, catalog: validateCatalog(json(catalogRead)), catalogRead };
}
const PROVENANCE_KEYS = ["inputSha256", "materializedAt", "dataThrough", "indexSha256", "copiedAt", "observationScope", "originalFreshnessVerified", "intermediateObservationsComplete", "runInventoryComplete", "basis"];
const smallProvenance = value => Object.fromEntries(PROVENANCE_KEYS.filter(key => Object.hasOwn(value || {}, key)).map(key => [key, value[key]]));
function narrowOptions(options, scopes) {
  return { status: options.status, provenance: smallProvenance(options.provenance), keywords: options.keywords.filter(row => scopes.some(scope => scope.keyword === row.keyword)).map(row => {
    const months = scopes.filter(scope => scope.keyword === row.keyword).map(scope => scope.month), pick = values => Object.fromEntries(Object.entries(values || {}).filter(([month]) => months.includes(month)));
    return { keyword: row.keyword, stayMonths: row.stayMonths.filter(month => months.includes(month)), collectionMonths: row.collectionMonths,
      inventoryStayMonths: (row.inventoryStayMonths || []).filter(month => months.includes(month)), rankMonths: (row.rankMonths || []).filter(month => months.includes(month)),
      defaultCutoffs: pick(row.defaultCutoffs), supportedCutoffs: row.supportedCutoffs ? pick(row.supportedCutoffs) : null };
  }) };
}
function composeOptions(catalog, parts, failures, base, identity) {
  const diagnostics = [], keywords = new Map();
  for (const scope of catalog.scopes) {
    const part = parts.get(scope.partition), item = part?.options.keywords.find(row => row.keyword === scope.keyword);
    const row = keywords.get(scope.keyword) || { keyword: scope.keyword, stayMonths: new Set(), collectionMonths: new Set(), inventoryStayMonths: new Set(), rankMonths: new Set(), defaultCutoffs: {}, supportedCutoffs: {}, provenanceByMonth: {}, availabilityByMonth: {} };
    row.stayMonths.add(scope.month); row.availabilityByMonth[scope.month] = part?.options.status || "needs_verification";
    if (item) {
      for (const month of item.collectionMonths) row.collectionMonths.add(month);
      for (const key of ["inventoryStayMonths", "rankMonths"]) if ((item[key] || []).includes(scope.month)) row[key].add(scope.month);
      if (item.defaultCutoffs?.[scope.month]) row.defaultCutoffs[scope.month] = item.defaultCutoffs[scope.month];
      if (item.supportedCutoffs?.[scope.month]) row.supportedCutoffs[scope.month] = item.supportedCutoffs[scope.month];
      row.provenanceByMonth[scope.month] = smallProvenance(part.options.provenance);
    }
    keywords.set(scope.keyword, row);
  }
  for (const row of keywords.values()) { for (const key of ["stayMonths", "collectionMonths", "inventoryStayMonths", "rankMonths"]) row[key] = [...row[key]].sort(); if (!Object.keys(row.supportedCutoffs).length) row.supportedCutoffs = null; }
  const available = [...parts.values()].filter(part => part.options.status === "available").length;
  if (failures.length) diagnostics.push("KEYWORD_MONTHLY_BUNDLE_SOME_PARTITIONS_UNAVAILABLE");
  if ([...parts.values()].some(part => part.options.status === "stale")) diagnostics.push("KEYWORD_MONTHLY_BUNDLE_STALE_PARTITIONS_PRESENT");
  const through = [...parts.values()].map(part => part.options.provenance?.dataThrough).filter(iso).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) || null;
  const result = { ...base, status: available ? "available" : parts.size ? "stale" : "needs_verification", keywords: [...keywords.values()].sort((a, b) => a.keyword.localeCompare(b.keyword)), diagnostics,
    provenance: { basis: "immutable_keyword_partition_bundle", bundleSha256: identity.catalogSha256, currentPointerSha256: identity.pointerSha256, catalogAssembledAt: catalog.createdAt, dataThrough: through, originalFreshnessVerified: false },
    bundle: { generation: identity.generation, partitionCount: catalog.partitions.length, scopeCount: catalog.scopes.length, unavailablePartitions: failures } };
  ensure(Buffer.byteLength(JSON.stringify(result)) <= LIMITS.optionsBytes, "KEYWORD_MONTHLY_BUNDLE_OPTIONS_RESPONSE_LIMIT"); return result;
}
async function partition(bundle, key, now, staleAfterMs, { optionsReader, measure = measureDefault, verifyAfter = true } = {}) {
  const descriptor = bundle.catalog.partitions.find(value => value.key === key); ensure(descriptor, "KEYWORD_MONTHLY_BUNDLE_PARTITION_MISSING");
  const directory = path.join(bundle.generationDir, "partitions", key);
  const index = await measure("keyword_index_read", { readCount: 1, inputBytes: descriptor.indexBytes }, () => readFile(path.join(directory, "index.json"), CHILD_LIMITS.indexBytes));
  ensure(index.sha256 === descriptor.indexSha256 && index.size === descriptor.indexBytes, "KEYWORD_MONTHLY_BUNDLE_PARTITION_MISMATCH");
  const service = createKeywordMonthlyAnalysis({ projectionDir: directory, now, measure, ...(staleAfterMs === undefined ? {} : { staleAfterMs }) });
  const reader = optionsReader || createKeywordMonthlyOptionsIndexReader({ now, measure, ...(staleAfterMs === undefined ? {} : { staleAfterMs }) });
  const options = await reader.project(index.bytes, index.sha256);
  ensure(["available", "stale"].includes(options.status), "KEYWORD_MONTHLY_BUNDLE_PARTITION_UNAVAILABLE");
  const declared = bundle.catalog.scopes.filter(value => value.partition === key);
  ensure(declared.every(value => options.keywords.some(row => row.keyword === value.keyword && row.stayMonths.includes(value.month))), "KEYWORD_MONTHLY_BUNDLE_SCOPE_MISMATCH");
  if (verifyAfter) {
    const after = await measure("keyword_index_read", { readCount: 1, inputBytes: descriptor.indexBytes }, () => readFile(path.join(directory, "index.json"), CHILD_LIMITS.indexBytes));
    ensure(after.sha256 === index.sha256 && after.size === index.size, "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ");
  }
  return { descriptor, directory, index: { file: index.file, sha256: index.sha256, size: index.size }, service, options: narrowOptions(options, declared) };
}
const safeError = error => /^KEYWORD_MONTHLY_[A-Z0-9_]+$/.test(error?.code || "") ? error.code : "KEYWORD_MONTHLY_BUNDLE_UNAVAILABLE";
async function settledIndexBatches(items, concurrency, operation, consume) {
  for (let offset = 0; offset < items.length; offset += concurrency) {
    const batch = items.slice(offset, offset + concurrency);
    // Every started read settles before consuming an error or starting the
    // next batch. Descriptor order, not completion order, owns the outcome.
    const results = await Promise.allSettled(batch.map(item => Promise.resolve().then(() => operation(item))));
    for (let index = 0; index < batch.length; index++) consume(results[index], batch[index]);
  }
}
function createKeywordMonthlyBundleAnalysis({ projectionDir, now = () => Date.now(), staleAfterMs, measure = measureDefault,
  runLegacyAnalysis = runKeywordMonthlyMemoryAdmission, optionsReadConcurrency = 4 } = {}) {
  ensure(typeof projectionDir === "string" && path.isAbsolute(projectionDir), "KEYWORD_MONTHLY_BUNDLE_ABSOLUTE_DIRECTORY_REQUIRED");
  if (typeof runLegacyAnalysis !== "function") throw new TypeError("A guarded legacy analysis callback is required");
  if (!Number.isSafeInteger(optionsReadConcurrency) || optionsReadConcurrency < 1 || optionsReadConcurrency > 8) throw new TypeError("Invalid keyword options read concurrency");
  const directory = path.resolve(projectionDir), legacy = createKeywordMonthlyAnalysis({ projectionDir: directory, now, measure, ...(staleAfterMs === undefined ? {} : { staleAfterMs }) });
  const optionsReader = createKeywordMonthlyOptionsIndexReader({ now, measure, ...(staleAfterMs === undefined ? {} : { staleAfterMs }) });
  const optionsFlights = new Map();
  const basic = () => { const currentDay = new Date(new Date(now()).getTime() + 9 * 3600000).toISOString().slice(0, 10); return { schemaVersion: 1, readOnly: true, networkAttempted: false, currentDay, currentMonth: currentDay.slice(0, 7) }; };
  const absent = (error, request) => {
    const readGuard = keywordMonthlyGuardDiagnosticFromError(error);
    return { ...basic(), status: "needs_verification", ...(request ? { request, snapshot: null } : { keywords: [] }), diagnostics: [safeError(error)], provenance: null, activity: null, latestAttempt: null, lastSuccessfulAttempt: null,
      ...(readGuard ? { readGuard } : {}) };
  };
  async function version() {
    const common = { schemaVersion: 1, currentDay: basic().currentDay, readOnly: true, networkAttempted: false, originalFreshnessVerified: false };
    try {
      // This is a publication notification only. Never open the catalog,
      // indexes, results, original sources or a legacy analysis from this path.
      const file = path.join(directory, "current.json"), first = await readFile(file, LIMITS.pointerBytes), pointer = validatePointer(json(first));
      const final = await readFile(file, LIMITS.pointerBytes); validatePointer(json(final));
      ensure(final.sha256 === first.sha256, "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ");
      return { ...common, status: "available", revision: first.sha256, generation: pointer.generation, publishedAt: pointer.publishedAt };
    } catch (error) {
      return { ...common, status: "needs_verification", revision: null, generation: null, publishedAt: null,
        diagnostics: [error?.code === "ENOENT" ? "KEYWORD_MONTHLY_BUNDLE_POINTER_MISSING" : safeError(error)] };
    }
  }
  async function catalogue() {
    // A selector is a declaration in the immutable prepared-result catalog,
    // not verification of the financial result or its partition indexes. This
    // bounded metadata capability must never enter a legacy/source calculator.
    try {
      const bundle = await measureKeywordMonthlyMetadata("catalogue_open",()=>loadBundle(directory)), current = basic();
      ensure(bundle.catalog.schemaVersion === 2, "KEYWORD_MONTHLY_CATALOGUE_NOT_PREPARED");
      const result=await measureKeywordMonthlyMetadata("catalogue_project",()=>{
      const rows = new Map(), cutoffSets = new Map();
      for (const descriptor of bundle.catalog.preparedResults) {
        ensure(descriptor.calculationFingerprint === calculationFingerprint(), "KEYWORD_MONTHLY_RESULT_CALCULATION_CHANGED");
        ensure(descriptor.cutoffDate <= current.currentDay, "KEYWORD_MONTHLY_RESULT_CLOCK_INVALID");
        let row = rows.get(descriptor.keyword);
        if (!row) {
          row = { keyword: descriptor.keyword, stayMonths: [], collectionMonths: [], inventoryStayMonths: [], rankMonths: [],
            defaultCutoffs: {}, supportedCutoffs: {}, provenanceByMonth: {}, availabilityByMonth: {} };
          rows.set(descriptor.keyword, row);
        }
        const id = scopeId(descriptor.keyword, descriptor.month);
        if (!cutoffSets.has(id)) { cutoffSets.set(id, new Set()); row.stayMonths.push(descriptor.month); }
        cutoffSets.get(id).add(descriptor.cutoffDate);
        if (!row.defaultCutoffs[descriptor.month] || descriptor.cutoffDate > row.defaultCutoffs[descriptor.month]) row.defaultCutoffs[descriptor.month] = descriptor.cutoffDate;
        row.availabilityByMonth[descriptor.month] = "declared";
      }
      for (const row of rows.values()) {
        row.stayMonths.sort();
        for (const month of row.stayMonths) {
          const cutoffs = cutoffSets.get(scopeId(row.keyword, month));
          if (cutoffs.size === 1) row.supportedCutoffs[month] = [...cutoffs][0];
        }
        if (!Object.keys(row.supportedCutoffs).length) row.supportedCutoffs = null;
      }
      const result = { ...current, status: "available", metadataOnly: true, financialResultValidated: false,
        keywords: [...rows.values()].sort((a, b) => a.keyword.localeCompare(b.keyword)),
        diagnostics: ["KEYWORD_MONTHLY_CATALOGUE_METADATA_ONLY"],
        provenance: { basis: "immutable_prepared_result_catalogue", bundleSha256: bundle.catalogRead.sha256,
          currentPointerSha256: bundle.pointerRead.sha256, catalogAssembledAt: bundle.catalog.createdAt, originalFreshnessVerified: false },
        bundle: { generation: bundle.pointer.generation, partitionCount: bundle.catalog.partitions.length,
          scopeCount: bundle.catalog.scopes.length, preparedResultCount: bundle.catalog.preparedResults.length } };
      ensure(Buffer.byteLength(JSON.stringify(result)) <= LIMITS.optionsBytes, "KEYWORD_MONTHLY_BUNDLE_OPTIONS_RESPONSE_LIMIT");
      return result;
      });
      // Revalidate the complete bounded catalog and pointer, not a cached stat.
      // The ordinary financial read still validates each selected index/result.
      await measureKeywordMonthlyMetadata("catalogue_revalidate",()=>unchanged(bundle));
      return result;
    } catch (error) { return { ...absent(error), metadataOnly: true, financialResultValidated: false }; }
  }
  async function open() { try { return await loadBundle(directory); } catch (error) { if (error.code === "ENOENT") {
      // Only a genuinely absent pointer permits the unchanged legacy reader.
      try { await fs.lstat(path.join(directory, "current.json")); } catch (missing) { if (missing.code === "ENOENT") return null; throw missing; }
    } throw error; } }
  async function legacyRead(operation) {
    const result = await operation();
    try { await fs.lstat(path.join(directory, "current.json")); throw fault("KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return result;
  }
  async function unchanged(bundle, part, indexReadConcurrency = 1) {
    const after = await loadBundle(directory); ensure(after.pointerRead.sha256 === bundle.pointerRead.sha256 && after.catalogRead.sha256 === bundle.catalogRead.sha256, "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ");
    const items = part ? Array.isArray(part) ? part : [part] : [];
    const verifyIndex = async item => {
      const index = await measure("keyword_index_read", { readCount: 1, inputBytes: item.index.size }, () => readFile(path.join(item.directory, "index.json"), CHILD_LIMITS.indexBytes));
      ensure(index.sha256 === item.index.sha256 && index.size === item.index.size, "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ");
    };
    if (indexReadConcurrency === 1) for (const item of items) await verifyIndex(item);
    else await settledIndexBatches(items, indexReadConcurrency, verifyIndex, result => { if (result.status === "rejected") throw result.reason; });
    // A publication during the final index pass cannot return the old generation.
    const final = await readFile(path.join(directory, "current.json"), LIMITS.pointerBytes);
    ensure(final.sha256 === bundle.pointerRead.sha256, "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ");
  }
  async function loadOptions(bundle) {
    const parts = new Map(), failures = [];
    // Each active index is bounded to 1MiB; only up to eight such reads are
    // admitted here. The unchanged 8MiB/64-entry cache retains metadata only.
    await settledIndexBatches(bundle.catalog.partitions, optionsReadConcurrency,
      descriptor => partition(bundle, descriptor.key, now, staleAfterMs, { optionsReader, measure, verifyAfter: false }),
      (result, descriptor) => {
        if (result.status === "fulfilled") parts.set(descriptor.key, result.value);
        else failures.push({ partition: descriptor.key, code: safeError(result.reason) });
      });
    // The final pass retains all index and pointer race checks, instead of
    // reparsing each index through a second child service before this pass.
    await unchanged(bundle, [...parts.values()], optionsReadConcurrency);
    return composeOptions(bundle.catalog, parts, failures, basic(), { catalogSha256: bundle.catalogRead.sha256, pointerSha256: bundle.pointerRead.sha256, generation: bundle.pointer.generation });
  }
  async function options() {
    let bundle; try {
      bundle = await open(); if (!bundle) return await legacyRead(() => legacy.options());
      const key = bundle.pointerRead.sha256, existing = optionsFlights.get(key);
      if (existing) return await measure("keyword_options_join", { cacheHits: 1 }, () => existing);
      // Bound in-flight metadata roots even if generations change rapidly.
      ensure(optionsFlights.size < 4, "KEYWORD_MONTHLY_BUNDLE_OPTIONS_BUSY");
      const pending = loadOptions(bundle); optionsFlights.set(key, pending);
      try { return await pending; }
      finally { if (optionsFlights.get(key) === pending) optionsFlights.delete(key); }
    } catch (error) { return absent(error); }
  }
  function validateInput(input) {
    ensure(plain(input) && Object.keys(input).every(key => ["keyword", "month", "cutoffDate"].includes(key)) && keywordValid(input.keyword) && MONTH.test(input.month), "KEYWORD_MONTHLY_INVALID_REQUEST", 400);
    if (input.cutoffDate !== undefined) ensure(typeof input.cutoffDate === "string" && /^20\d{2}-\d\d-\d\d$/.test(input.cutoffDate)
      && Number.isFinite(Date.parse(`${input.cutoffDate}T00:00:00Z`)) && new Date(`${input.cutoffDate}T00:00:00Z`).toISOString().slice(0, 10) === input.cutoffDate
      && input.cutoffDate <= basic().currentDay, "KEYWORD_MONTHLY_INVALID_REQUEST", 400);
  }
  const notPrepared = (request, code) => ({ ...basic(), status: "missing", request: { ...request }, snapshot: null,
    activity: null, latestAttempt: null, lastSuccessfulAttempt: null, provenance: null, diagnostics: [code],
    preparedResult: { status: "not_prepared", reasonCode: code } });
  async function readPrepared(input) {
    validateInput(input);
    try {
      return await runKeywordMonthlyMemoryAdmission(async () => {
      const bundle = await open();
      if (!bundle) return await legacyRead(() => notPrepared(input, "KEYWORD_MONTHLY_RESULT_NOT_PREPARED"));
      const scope = bundle.catalog.scopes.find(value => value.keyword === input.keyword && value.month === input.month);
      if (!scope) { await unchanged(bundle); return { ...basic(), status: "missing", request: { ...input }, snapshot: null, diagnostics: ["KEYWORD_MONTHLY_SCOPE_NOT_PREPARED"], activity: null, latestAttempt: null, lastSuccessfulAttempt: null,
        provenance: { bundleSha256: bundle.catalogRead.sha256, currentPointerSha256: bundle.pointerRead.sha256 } }; }
      if (bundle.catalog.schemaVersion === 1) { await unchanged(bundle); return notPrepared(input, "KEYWORD_MONTHLY_RESULT_NOT_PREPARED"); }
      const part = await partition(bundle, scope.partition, now, staleAfterMs, { optionsReader, measure });
      const option = part.options.keywords.find(row => row.keyword === input.keyword), request = { ...input, cutoffDate: input.cutoffDate || option.defaultCutoffs[input.month] };
      const descriptor = bundle.catalog.preparedResults.find(value => queryId(value) === queryId(request));
      if (!descriptor) { await unchanged(bundle, part); return notPrepared(request, "KEYWORD_MONTHLY_CUTOFF_RESULT_NOT_PREPARED"); }
      const sourceRead = await readFile(part.index.file, CHILD_LIMITS.indexBytes);
      ensure(sourceRead.sha256 === part.index.sha256 && sourceRead.size === part.index.size, "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ");
      const sourceIndex = json(sourceRead);
      const sourceScope = sourceIndex.keywords.find(row => row.keyword === input.keyword)?.scopes.find(row => row.month === input.month);
      ensure(sourceScope?.sha256 === descriptor.sourceProjectionSha256 && descriptor.partition === part.index.sha256, "KEYWORD_MONTHLY_RESULT_SOURCE_MISMATCH");
      const preparedFile = path.join(bundle.generationDir, "results", `${descriptor.sha256}.json${descriptor.encoding === "gzip" ? ".gz" : ""}`);
      const read = await measure("keyword_prepared_result_read", { inputBytes: descriptor.bytes, ...(descriptor.uncompressedBytes ? { uncompressedBytes: descriptor.uncompressedBytes } : {}), readCount: 1 },
        () => readFile(preparedFile, RESULT_LIMITS.encodedBytes));
      const current = basic(), result = await measure("keyword_prepared_result_parse", { inputBytes: descriptor.bytes }, () => decodePreparedResult(read, descriptor,
        { currentDay: current.currentDay, now: new Date(now()).toISOString(), ...(staleAfterMs === undefined ? {} : { staleAfterMs }), sourceProvenance: sourceIndex.provenance }));
      await unchanged(bundle, part);
      // Decoding/validation can yield to another writer. The exact artifact
      // inode, link count and mutation clocks must still be the one read.
      ensure(sameStat(read.stamp, await checkPath(preparedFile)), "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ");
      // Keep pointer selection the final cheap validation after that path read.
      ensure((await readFile(path.join(directory, "current.json"), LIMITS.pointerBytes)).sha256 === bundle.pointerRead.sha256, "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ");
      const resultId = hash(JSON.stringify([bundle.pointerRead.sha256, bundle.catalogRead.sha256, part.index.sha256, result.request]));
      return { ...result, resultId, provenance: { ...result.provenance, bundleSha256: bundle.catalogRead.sha256, currentPointerSha256: bundle.pointerRead.sha256, partitionIndexSha256: part.index.sha256 },
        bundle: { generation: bundle.pointer.generation, partition: scope.partition, catalogSha256: bundle.catalogRead.sha256 } };
      });
    } catch (error) { if (error.statusCode === 400) throw error; return absent(error, input); }
  }
  async function analyze(input) {
    validateInput(input);
    let bundle; try {
      bundle = await open();
      if (bundle?.catalog.schemaVersion === 2) {
        const saved = await readPrepared(input);
        if (saved.preparedResult?.status !== "not_prepared") return saved;
      }
      if (!bundle) return await runLegacyAnalysis(() => legacyRead(() => legacy.analyze(input)));
      const scope = bundle.catalog.scopes.find(value => value.keyword === input.keyword && value.month === input.month);
      if (!scope) { await unchanged(bundle); return { ...basic(), status: "missing", request: input, snapshot: null, diagnostics: ["KEYWORD_MONTHLY_SCOPE_NOT_PREPARED"], activity: null, latestAttempt: null, lastSuccessfulAttempt: null, provenance: { bundleSha256: bundle.catalogRead.sha256, currentPointerSha256: bundle.pointerRead.sha256 } }; }
      const part = await partition(bundle, scope.partition, now, staleAfterMs, { optionsReader, measure }), result = await runLegacyAnalysis(() => part.service.analyze(input)); await unchanged(bundle, part);
      const resultId = hash(JSON.stringify([bundle.pointerRead.sha256, bundle.catalogRead.sha256, part.index.sha256, result.request || input]));
      return { ...result, resultId, provenance: result.provenance ? { ...result.provenance, bundleSha256: bundle.catalogRead.sha256, currentPointerSha256: bundle.pointerRead.sha256, partitionIndexSha256: part.index.sha256 } : null,
        bundle: { generation: bundle.pointer.generation, partition: scope.partition, catalogSha256: bundle.catalogRead.sha256 } };
    } catch (error) { if (error.statusCode === 400) throw error; return absent(error, input); }
  }
  return Object.freeze({ options, readPrepared, analyze, version, catalogue });
}
async function ensureDirectory(directory) {
  try { await checkPath(directory, true); } catch (error) { if (error.code !== "ENOENT") throw error; await checkPath(path.dirname(directory), true); await fs.mkdir(directory, { mode: 0o700 }); await checkPath(directory, true); }
}
const resultName = descriptor => `${descriptor.sha256}.json${descriptor.encoding === "gzip" ? ".gz" : ""}`;
function validateResultBuild(prepareResults, preparedQueries) {
  ensure(typeof prepareResults === "boolean" && Array.isArray(preparedQueries) && preparedQueries.length <= RESULT_LIMITS.results
    && (prepareResults || preparedQueries.length === 0), "KEYWORD_MONTHLY_RESULT_BUILD_INVALID");
  const ids = new Set();
  for (const query of preparedQueries) {
    ensure(exact(query, ["keyword", "month", "cutoffDate"]) && keywordValid(query.keyword) && MONTH.test(query.month)
      && typeof query.cutoffDate === "string" && /^20\d{2}-\d\d-\d\d$/.test(query.cutoffDate)
      && Number.isFinite(Date.parse(`${query.cutoffDate}T00:00:00Z`)) && new Date(`${query.cutoffDate}T00:00:00Z`).toISOString().slice(0, 10) === query.cutoffDate
      && !ids.has(queryId(query)), "KEYWORD_MONTHLY_RESULT_QUERY_INVALID"); ids.add(queryId(query));
  }
}
function validPreparationShape(value) {
  return exact(value, ["schemaVersion", "kind", "fixedValidationClock", "maxTotalBytes", "inputsFingerprint", "parts", ...(value?.schemaVersion === 2 ? ["preparedResults"] : [])])
    && [1, 2].includes(value.schemaVersion) && value.kind === PREVALIDATION_KIND && iso(value.fixedValidationClock)
    && Array.isArray(value.parts) && value.parts.length > 0 && value.parts.length <= LIMITS.partitions
    && Number.isSafeInteger(value.maxTotalBytes) && value.maxTotalBytes > 0 && value.maxTotalBytes <= 8 * 1024 * 1024 * 1024 && SHA.test(value.inputsFingerprint || "")
    && Buffer.byteLength(JSON.stringify(value)) <= PREVALIDATION_BYTES;
}
async function savePreparedAnalysis(result, partitionKey, directory, descriptors, maximum) {
  const saved = encodePreparedResult(result, { partition: partitionKey });
  ensure(descriptors.length < RESULT_LIMITS.results, "KEYWORD_MONTHLY_RESULT_CATALOG_BOUND");
  ensure(descriptors.reduce((sum, row) => sum + row.bytes, 0) + saved.bytes.length <= maximum, "KEYWORD_MONTHLY_BUNDLE_TOTAL_BOUND");
  const file = path.join(directory, resultName(saved.descriptor));
  await fs.writeFile(file, saved.bytes, { flag: "wx", mode: 0o600 });
  const check = await readFile(file, RESULT_LIMITS.encodedBytes);
  ensure(check.sha256 === saved.descriptor.sha256 && check.size === saved.descriptor.bytes, "KEYWORD_MONTHLY_RESULT_COPY_MISMATCH");
  descriptors.push(saved.descriptor);
}
// This validation uses only bounded metadata and file bytes. The attested
// isolated child already decoded and semantically validated each final result.
async function preparedMetadata(preparation, parts, checkpoint = null) {
  if (preparation.schemaVersion === 1) return null;
  const saved = preparation.preparedResults;
  ensure(exact(saved, ["directory", "calculationFingerprint", "descriptors"])
    && typeof saved.directory === "string" && path.isAbsolute(saved.directory) && path.resolve(saved.directory) === saved.directory
    && saved.directory !== path.parse(saved.directory).root && saved.calculationFingerprint === calculationFingerprint()
    && Array.isArray(saved.descriptors) && saved.descriptors.length > 0 && saved.descriptors.length <= RESULT_LIMITS.results, "KEYWORD_MONTHLY_BUNDLE_PREVALIDATION_INVALID");
  const scopes = new Map(), ids = new Set(), indexes = new Map();
  for (const part of parts) {
    if (checkpoint) await checkpoint();
    let index = indexes.get(part.index.sha256);
    if (!index) { index = json(await readFile(part.index.file, CHILD_LIMITS.indexBytes)); indexes.set(part.index.sha256, index); }
    for (const scope of part.exposed) scopes.set(scopeId(scope.keyword, scope.month), { part, index });
  }
  for (const descriptor of saved.descriptors) {
    validatePreparedDescriptor(descriptor); const item = scopes.get(scopeId(descriptor.keyword, descriptor.month)), id = queryId(descriptor);
    const source = item?.index.keywords.find(row => row.keyword === descriptor.keyword)?.scopes.find(row => row.month === descriptor.month);
    ensure(item && descriptor.partition === item.part.index.sha256 && source && descriptor.sourceProjectionSha256 === source.sha256
      && descriptor.calculationFingerprint === saved.calculationFingerprint && !ids.has(id), "KEYWORD_MONTHLY_BUNDLE_PREVALIDATION_INVALID"); ids.add(id);
  }
  for (const { part } of scopes.values()) for (const row of part.validation) ensure(ids.has(queryId(row.query)), "KEYWORD_MONTHLY_BUNDLE_PREVALIDATION_INVALID");
  await exactDirectoryEntries(saved.directory, saved.descriptors.map(resultName), RESULT_LIMITS.results);
  for (const descriptor of saved.descriptors) {
    if (checkpoint) await checkpoint();
    const read = await readFile(path.join(saved.directory, resultName(descriptor)), RESULT_LIMITS.encodedBytes);
    ensure(read.sha256 === descriptor.sha256 && read.size === descriptor.bytes, "KEYWORD_MONTHLY_RESULT_COPY_MISMATCH");
  }
  return saved;
}
async function inputPartition(input, now, prevalidated = null, resultOutput = null, checkpoint = null) {
  ensure(plain(input) && Object.keys(input).every(key => ["directory", "exposeScopes"].includes(key)) && typeof input.directory === "string" && path.isAbsolute(input.directory), "KEYWORD_MONTHLY_BUNDLE_INPUT_DIRECTORY");
  const directory = path.resolve(input.directory), index = await readFile(path.join(directory, "index.json"), CHILD_LIMITS.indexBytes), value = json(index);
  const service = createKeywordMonthlyAnalysis({ projectionDir: directory, now: () => now }), options = await service.options();
  ensure(["available", "stale"].includes(options.status), "KEYWORD_MONTHLY_BUNDLE_INPUT_UNAVAILABLE");
  const all = options.keywords.flatMap(row => row.stayMonths.map(month => ({ keyword: row.keyword, month })));
  const exposed = input.exposeScopes === undefined ? all : input.exposeScopes;
  ensure(Array.isArray(exposed) && exposed.length > 0 && exposed.length <= LIMITS.scopes && exposed.every(scope => plain(scope) && Object.keys(scope).every(key => ["keyword", "month"].includes(key))
    && all.some(value => value.keyword === scope.keyword && value.month === scope.month)), "KEYWORD_MONTHLY_BUNDLE_INPUT_SCOPE");
  const files = [];
  for (const item of value.keywords) for (const scope of item.scopes) {
    if (checkpoint) await checkpoint();
    ensure(SHA.test(scope.scopeKey) && SHA.test(scope.sha256) && Number.isSafeInteger(scope.bytes) && scope.bytes > 0 && scope.bytes <= CHILD_LIMITS.projectionBytes, "KEYWORD_MONTHLY_BUNDLE_INPUT_SCOPE");
    const name = `${scope.scopeKey}.json${scope.encoding === "gzip" ? ".gz" : ""}`;
    const read = await readFile(path.join(directory, "projections", name), CHILD_LIMITS.projectionBytes);
    ensure(read.sha256 === scope.sha256 && read.size === scope.bytes, "KEYWORD_MONTHLY_BUNDLE_INPUT_PROJECTION_MISMATCH"); files.push({ name, sha256: read.sha256, bytes: read.size });
  }
  const validation = [];
  if (prevalidated !== null) {
    // Only the incremental host may supply this path, after binding the complete
    // descriptor to its successful, network-denied child's PID/proof/receipt.
    // Re-read every stored byte/index and reconstruct options here. Never parse
    // a normalized projection or rebuild a financial graph in the web parent.
    const metadata = { directory, index: { file: index.file, sha256: index.sha256, size: index.size }, exposed, files, options: narrowOptions(options, exposed) };
    ensure(exact(prevalidated, ["directory", "index", "exposed", "files", "validation", "options"])
      && JSON.stringify(Object.fromEntries(Object.keys(metadata).map(key => [key, prevalidated[key]]))) === JSON.stringify(metadata)
      && Array.isArray(prevalidated.validation) && prevalidated.validation.length === exposed.length, "KEYWORD_MONTHLY_BUNDLE_PREVALIDATION_INVALID");
    for (let position = 0; position < exposed.length; position++) {
      const scope = exposed[position], item = options.keywords.find(row => row.keyword === scope.keyword), query = { keyword: scope.keyword, month: scope.month, cutoffDate: item.defaultCutoffs[scope.month] }, row = prevalidated.validation[position];
      const dataThroughDay = new Date(Date.parse(options.provenance.dataThrough) + 9 * 3600000).toISOString().slice(0, 10);
      const expectedStatus = options.status === "stale" || options.provenance.observationScope !== "selected_only" && query.cutoffDate > dataThroughDay ? "stale" : "available";
      ensure(exact(row, ["query", "status", "selectedDigest", "inputSha256", "dataThrough"])
        && exact(row.query, ["keyword", "month", "cutoffDate"]) && JSON.stringify(row.query) === JSON.stringify(query)
        && row.status === expectedStatus && SHA.test(row.selectedDigest) && row.inputSha256 === options.provenance.inputSha256
        && row.dataThrough === options.provenance.dataThrough, "KEYWORD_MONTHLY_BUNDLE_PREVALIDATION_INVALID");
      validation.push({ ...row, query: { ...row.query } });
    }
  } else {
    for (const scope of exposed) {
      const item = options.keywords.find(row => row.keyword === scope.keyword), query = { keyword: scope.keyword, month: scope.month, cutoffDate: item.defaultCutoffs[scope.month] }, result = await service.analyze(query);
      if (!(["available", "stale"].includes(result.status) && result.snapshot && result.request.keyword === query.keyword && result.request.month === query.month && result.request.cutoffDate === query.cutoffDate && SHA.test(result.snapshot.sources?.digest || ""))) throw Object.assign(fault("KEYWORD_MONTHLY_BUNDLE_INPUT_ANALYSIS_FAILED"), { scope: query, inputStatus: result.status, diagnostics: result.diagnostics });
      validation.push({ query, status: result.status, selectedDigest: result.snapshot.sources.digest, inputSha256: result.provenance.inputSha256, dataThrough: result.provenance.dataThrough });
      if (resultOutput) await savePreparedAnalysis(result, index.sha256, resultOutput.directory, resultOutput.descriptors, resultOutput.maximum);
    }
  }
  ensure((await readFile(path.join(directory, "index.json"), CHILD_LIMITS.indexBytes)).sha256 === index.sha256, "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ");
  return { directory, index: { file: index.file, sha256: index.sha256, size: index.size }, exposed, files, validation, options: narrowOptions(options, exposed) };
}
async function prepareKeywordMonthlyBundle({ inputs, now, maxTotalBytes = LIMITS.defaultTotalBytes,
  prepareResults = false, preparedQueries = [], preparedOutputDir } = {}) {
  ensure(Array.isArray(inputs) && inputs.length > 0 && inputs.length <= LIMITS.partitions && iso(now), "KEYWORD_MONTHLY_BUNDLE_BUILD_INPUT");
  ensure(Number.isSafeInteger(maxTotalBytes) && maxTotalBytes > 0 && maxTotalBytes <= 8 * 1024 * 1024 * 1024, "KEYWORD_MONTHLY_BUNDLE_TOTAL_BOUND");
  validateResultBuild(prepareResults, preparedQueries);
  let resultOutput = null;
  if (prepareResults) {
    ensure(typeof preparedOutputDir === "string" && path.isAbsolute(preparedOutputDir) && path.resolve(preparedOutputDir) === preparedOutputDir
      && preparedOutputDir !== path.parse(preparedOutputDir).root, "KEYWORD_MONTHLY_RESULT_OUTPUT_INVALID");
    await checkPath(path.dirname(preparedOutputDir), true); await fs.mkdir(preparedOutputDir, { mode: 0o700 }); await checkPath(preparedOutputDir, true);
    resultOutput = { directory: preparedOutputDir, calculationFingerprint: calculationFingerprint(), descriptors: [] };
    Object.defineProperty(resultOutput, "maximum", { value: maxTotalBytes });
  }
  const parts = []; for (const input of inputs) parts.push(await inputPartition(input, now, null, resultOutput));
  if (resultOutput) {
    for (const query of preparedQueries) {
      const part = parts.find(value => value.exposed.some(scope => scope.keyword === query.keyword && scope.month === query.month));
      ensure(part, "KEYWORD_MONTHLY_RESULT_QUERY_UNEXPOSED");
      if (resultOutput.descriptors.some(row => queryId(row) === queryId(query))) continue;
      const result = await createKeywordMonthlyAnalysis({ projectionDir: part.directory, now: () => now }).analyze(query);
      ensure(["available", "stale"].includes(result.status) && result.snapshot && queryId(result.request) === queryId(query), "KEYWORD_MONTHLY_BUNDLE_INPUT_ANALYSIS_FAILED");
      await savePreparedAnalysis(result, part.index.sha256, resultOutput.directory, resultOutput.descriptors, maxTotalBytes);
    }
    resultOutput.descriptors.sort((a, b) => queryId(a).localeCompare(queryId(b)));
  }
  const value = { schemaVersion: prepareResults ? 2 : 1, kind: PREVALIDATION_KIND, fixedValidationClock: new Date(now).toISOString(), maxTotalBytes, inputsFingerprint: inputIdentity(inputs), parts,
    ...(resultOutput ? { preparedResults: resultOutput } : {}) };
  await preparedMetadata(value, parts);
  const unique = new Map(parts.map(part => [part.index.sha256, part]));
  ensure([...unique.values()].reduce((sum, part) => sum + part.index.size + part.files.reduce((total, file) => total + file.bytes, 0), 0)
    + (resultOutput?.descriptors.reduce((sum, row) => sum + row.bytes, 0) || 0) <= maxTotalBytes, "KEYWORD_MONTHLY_BUNDLE_TOTAL_BOUND");
  ensure(Buffer.byteLength(JSON.stringify(value)) <= PREVALIDATION_BYTES, "KEYWORD_MONTHLY_BUNDLE_PREVALIDATION_BOUND");
  return value;
}
async function publishKeywordMonthlyBundle(options = {}) {
  // Generic explicit/offline publication performs semantic validation here.
  // The web incremental parent always calls the prevalidated API instead.
  let temporary;
  if (options.prepareResults && !options.preparedOutputDir) temporary = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-monthly-final-results-"));
  try {
    const preparation = await prepareKeywordMonthlyBundle({ ...options, ...(temporary ? { preparedOutputDir: path.join(temporary, "results") } : {}) });
    return await publishPrevalidatedKeywordMonthlyBundle({ ...options, preparation });
  } finally {
    // Only remove the exact newly-created, owned namespace. Unknown artifacts
    // hold cleanup; no recursive or wildcard removal reaches existing data.
    if (temporary) {
      try { const directory = path.join(temporary, "results"), entries = await fs.readdir(directory, { withFileTypes: true });
        if (entries.every(entry => entry.isFile() && /^[a-f0-9]{64}\.json(?:\.gz)?$/.test(entry.name))) {
          for (const entry of entries) { await checkPath(path.join(directory, entry.name)); await fs.unlink(path.join(directory, entry.name)); }
          await fs.rmdir(directory); await fs.rmdir(temporary);
        }
      } catch {} // Failed/unknown preparation evidence is retained for review.
    }
  }
}
async function publishPrevalidatedKeywordMonthlyBundle({ inputs, outputDir, now, expectedCurrentSha256 = null, maxTotalBytes = LIMITS.defaultTotalBytes, beforePromote, preparation,
  checkpoint = null, runAtomic = operation => operation() } = {}) {
  ensure((checkpoint === null || typeof checkpoint === "function") && typeof runAtomic === "function", "KEYWORD_MONTHLY_BUNDLE_BUILD_INPUT");
  ensure(Array.isArray(inputs) && inputs.length > 0 && inputs.length <= LIMITS.partitions && typeof outputDir === "string" && path.isAbsolute(outputDir) && iso(now), "KEYWORD_MONTHLY_BUNDLE_BUILD_INPUT");
  ensure(Number.isSafeInteger(maxTotalBytes) && maxTotalBytes > 0 && maxTotalBytes <= 8 * 1024 * 1024 * 1024, "KEYWORD_MONTHLY_BUNDLE_TOTAL_BOUND");
  ensure(expectedCurrentSha256 === null || SHA.test(expectedCurrentSha256), "KEYWORD_MONTHLY_BUNDLE_EXPECTED_POINTER");
  ensure(validPreparationShape(preparation) && preparation.fixedValidationClock === new Date(now).toISOString()
    && preparation.maxTotalBytes === maxTotalBytes && preparation.inputsFingerprint === inputIdentity(inputs)
    && Array.isArray(preparation.parts) && preparation.parts.length === inputs.length
    && Buffer.byteLength(JSON.stringify(preparation)) <= PREVALIDATION_BYTES, "KEYWORD_MONTHLY_BUNDLE_PREVALIDATION_INVALID");
  const prepared = []; for (let position = 0; position < inputs.length; position++) {
    if (checkpoint) await checkpoint(); prepared.push(await inputPartition(inputs[position], now, preparation.parts[position], null, checkpoint));
  }
  const preparedResults = await preparedMetadata(preparation, prepared, checkpoint);
  const partitions = new Map(), scopes = [], seen = new Set(); let totalBytes = 0;
  for (const part of prepared) {
    if (!partitions.has(part.index.sha256)) { partitions.set(part.index.sha256, { ...part }); totalBytes += part.index.size + part.files.reduce((sum, file) => sum + file.bytes, 0); }
    for (const scope of part.exposed) { const id = scopeId(scope.keyword, scope.month); ensure(!seen.has(id), "KEYWORD_MONTHLY_BUNDLE_SCOPE_CONFLICT"); seen.add(id); scopes.push({ ...scope, partition: part.index.sha256 }); }
  }
  ensure(scopes.length <= LIMITS.scopes && totalBytes <= maxTotalBytes, "KEYWORD_MONTHLY_BUNDLE_TOTAL_BOUND");
  let catalog = validateCatalog({ schemaVersion: 1, kind: "keyword_monthly_partition_bundle", createdAt: new Date(now).toISOString(),
    partitions: [...partitions].map(([key, part]) => ({ key, indexSha256: key, indexBytes: part.index.size })), scopes: scopes.sort((a, b) => scopeId(a.keyword, a.month).localeCompare(scopeId(b.keyword, b.month))) });
  const scopePlanSha256 = hash(Buffer.from(JSON.stringify(catalog)));
  if (preparedResults) catalog = validateCatalog({ ...catalog, schemaVersion: 2, preparedResults: preparedResults.descriptors });
  const catalogBytes = Buffer.from(JSON.stringify(catalog)); ensure(catalogBytes.length <= LIMITS.catalogBytes, "KEYWORD_MONTHLY_BUNDLE_SIZE_LIMIT");
  // Recombine a repeated identical input index's explicit subsets before the
  // exact same options-size check used by the runtime reader.
  for (const [key, part] of partitions) {
    if (checkpoint) await checkpoint();
    const headers = await createKeywordMonthlyAnalysis({ projectionDir: part.directory, now: () => now }).options();
    ensure(["available", "stale"].includes(headers.status), "KEYWORD_MONTHLY_BUNDLE_INPUT_UNAVAILABLE");
    part.options = narrowOptions(headers, scopes.filter(scope => scope.partition === key));
  }
  const currentDay = new Date(Date.parse(now) + 9 * 3600000).toISOString().slice(0, 10);
  composeOptions(catalog, new Map([...partitions].map(([key, part]) => [key, { options: part.options }])), [], { schemaVersion: 1, readOnly: true, networkAttempted: false, currentDay, currentMonth: currentDay.slice(0, 7) }, { catalogSha256: hash(catalogBytes), pointerSha256: "0".repeat(64), generation: "0".repeat(32) });
  const directory = path.resolve(outputDir); ensure(directory !== path.parse(directory).root, "KEYWORD_MONTHLY_BUNDLE_OUTPUT_ROOT_FORBIDDEN"); await ensureDirectory(directory); await ensureDirectory(path.join(directory, "generations"));
  let previousPointer = null; try { previousPointer = await readFile(path.join(directory, "current.json"), LIMITS.pointerBytes); validatePointer(json(previousPointer)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  ensure(previousPointer ? previousPointer.sha256 === expectedCurrentSha256 : expectedCurrentSha256 === null, "KEYWORD_MONTHLY_BUNDLE_POINTER_CONFLICT");
  const generation = crypto.randomBytes(16).toString("hex"), generationDir = path.join(directory, "generations", generation); await fs.mkdir(generationDir, { mode: 0o700 }); await fs.mkdir(path.join(generationDir, "partitions"), { mode: 0o700 });
  for (const [key, part] of partitions) {
    const target = path.join(generationDir, "partitions", key); await fs.mkdir(target, { mode: 0o700 }); await fs.mkdir(path.join(target, "projections"), { mode: 0o700 });
    for (const file of part.files) { if (checkpoint) await checkpoint(); const read = await readFile(path.join(part.directory, "projections", file.name), CHILD_LIMITS.projectionBytes); ensure(read.sha256 === file.sha256 && read.size === file.bytes, "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ"); await fs.writeFile(path.join(target, "projections", file.name), read.bytes, { flag: "wx", mode: 0o600 }); const copied = await readFile(path.join(target, "projections", file.name), CHILD_LIMITS.projectionBytes); ensure(copied.sha256 === file.sha256 && copied.size === file.bytes, "KEYWORD_MONTHLY_BUNDLE_COPY_MISMATCH"); }
    const index = await readFile(path.join(part.directory, "index.json"), CHILD_LIMITS.indexBytes); ensure(index.sha256 === key && index.size === part.index.size, "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ"); await fs.writeFile(path.join(target, "index.json"), index.bytes, { flag: "wx", mode: 0o600 });
  }
  if (preparedResults) {
    const target = path.join(generationDir, "results"); await fs.mkdir(target, { mode: 0o700 });
    for (const descriptor of preparedResults.descriptors) {
      if (checkpoint) await checkpoint();
      const saved = await readFile(path.join(preparedResults.directory, resultName(descriptor)), RESULT_LIMITS.encodedBytes);
      ensure(saved.sha256 === descriptor.sha256 && saved.size === descriptor.bytes, "KEYWORD_MONTHLY_RESULT_COPY_MISMATCH");
      totalBytes += saved.size; ensure(totalBytes <= maxTotalBytes, "KEYWORD_MONTHLY_BUNDLE_TOTAL_BOUND");
      await fs.writeFile(path.join(target, resultName(descriptor)), saved.bytes, { flag: "wx", mode: 0o600 });
      const copied = await readFile(path.join(target, resultName(descriptor)), RESULT_LIMITS.encodedBytes);
      ensure(copied.sha256 === descriptor.sha256 && copied.size === descriptor.bytes, "KEYWORD_MONTHLY_RESULT_COPY_MISMATCH");
    }
  }
  await fs.writeFile(path.join(generationDir, "catalog.json"), catalogBytes, { flag: "wx", mode: 0o600 });
  const pointer = { schemaVersion: 1, generation, catalogSha256: hash(catalogBytes), catalogBytes: catalogBytes.length, publishedAt: new Date(now).toISOString() }, pointerBytes = Buffer.from(JSON.stringify(pointer));
  // A cooperative, exclusive lock plus expected old SHA avoids last-writer-wins.
  const lockFile = path.join(directory, "publish.lock"), nonce = crypto.randomBytes(16).toString("hex"), lockBytes = Buffer.from(JSON.stringify({ generation, nonce }));
  let lock; try { lock = await fs.open(lockFile, "wx", 0o600); } catch (error) { if (error.code === "EEXIST") throw fault("KEYWORD_MONTHLY_BUNDLE_PUBLICATION_LOCKED"); throw error; } let lockStamp, promoted = false;
  const committedError = error => Object.assign(fault("KEYWORD_MONTHLY_BUNDLE_PUBLICATION_NEEDS_READBACK"), { publicationState: "pointer_was_promoted_verify_current", generation, pointerSha256: hash(pointerBytes), causeCode: safeError(error) });
  try {
    await lock.writeFile(lockBytes); await lock.sync(); lockStamp = await lock.stat();
    let previous = null; try { previous = await readFile(path.join(directory, "current.json"), LIMITS.pointerBytes); validatePointer(json(previous)); } catch (error) { if (error.code !== "ENOENT") throw error; }
    ensure(previous ? previous.sha256 === expectedCurrentSha256 : expectedCurrentSha256 === null, "KEYWORD_MONTHLY_BUNDLE_POINTER_CONFLICT");
    if (beforePromote) await beforePromote(Object.freeze({ schemaVersion: 1, kind: "keyword_monthly_catalog_candidate",
      generation, catalogSchemaVersion: catalog.schemaVersion, catalogSha256: pointer.catalogSha256, catalogBytes: catalogBytes.length,
      scopePlanSha256, partitionCount: partitions.size, scopeCount: scopes.length,
      preparedResultCount: catalog.preparedResults?.length || 0, ...(preparedResults ? { calculationFingerprint: preparedResults.calculationFingerprint } : {}) }));
    return await runAtomic(async () => {
    // Host checkpoint loans have drained. Revalidate every candidate file and
    // the expected old pointer inside the same exclusive promotion/readback.
    let atomicPrevious = null; try { atomicPrevious = await readFile(path.join(directory, "current.json"), LIMITS.pointerBytes); validatePointer(json(atomicPrevious)); } catch (error) { if (error.code !== "ENOENT") throw error; }
    ensure((atomicPrevious?.sha256 || null) === (previous?.sha256 || null), "KEYWORD_MONTHLY_BUNDLE_POINTER_CONFLICT");
    const finalCatalog = await readFile(path.join(generationDir, "catalog.json"), LIMITS.catalogBytes);
    ensure(finalCatalog.sha256 === pointer.catalogSha256 && finalCatalog.size === catalogBytes.length, "KEYWORD_MONTHLY_BUNDLE_CHANGED_BEFORE_PROMOTION");
    for (const [key, part] of partitions) {
      const finalIndex = await readFile(path.join(generationDir, "partitions", key, "index.json"), CHILD_LIMITS.indexBytes);
      ensure(finalIndex.sha256 === key && finalIndex.size === part.index.size, "KEYWORD_MONTHLY_BUNDLE_CHANGED_BEFORE_PROMOTION");
    }
    if (preparedResults) for (const descriptor of preparedResults.descriptors) {
      const saved = await readFile(path.join(generationDir, "results", resultName(descriptor)), RESULT_LIMITS.encodedBytes);
      ensure(saved.sha256 === descriptor.sha256 && saved.size === descriptor.bytes, "KEYWORD_MONTHLY_RESULT_CHANGED_BEFORE_PROMOTION");
    }
    const temporary = path.join(directory, `.current-${generation}.tmp`), handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(pointerBytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, path.join(directory, "current.json"));
    promoted = true;
    const readback = await loadBundle(directory); ensure(readback.pointerRead.sha256 === hash(pointerBytes) && readback.catalogRead.sha256 === pointer.catalogSha256, "KEYWORD_MONTHLY_BUNDLE_PUBLICATION_READBACK");
    const receipt = { schemaVersion: 1, status: "published", generation, bundleDir: directory, totalStoredBytes: totalBytes, pointerSha256: hash(pointerBytes), previousPointerSha256: previous?.sha256 || null,
      catalogSha256: pointer.catalogSha256, partitionCount: partitions.size, scopeCount: scopes.length, fixedValidationClock: new Date(now).toISOString(),
      ...(preparedResults ? { preparedResultCount: preparedResults.descriptors.length, calculationFingerprint: preparedResults.calculationFingerprint } : {}),
      partitions: prepared.map(part => ({ inputIndexSha256: part.index.sha256, inputIndexBytes: part.index.size, validation: part.validation })),
      sourceProvenancePreserved: true, originalEnvelopesRewritten: false, providerCalls: 0, collectorStarted: false, kosisReadOrChanged: false,
      semanticPrevalidationSha256: hash(JSON.stringify(preparation)), publicationProjectionAnalyses: 0,
      freshnessPolicy: "Original child materializedAt/dataThrough/status retained; bundle assembly never refreshes historical source provenance." };
    await fs.writeFile(path.join(generationDir, "publication-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 }); return receipt;
    });
  } catch (error) { if (promoted) throw committedError(error); throw error; }
  finally {
    try { await lock.close();
      if (lockStamp) { const stat = await checkPath(lockFile), current = await readFile(lockFile, LIMITS.pointerBytes); ensure(sameStat(stat, lockStamp) && current.sha256 === hash(lockBytes), "KEYWORD_MONTHLY_BUNDLE_LOCK_CHANGED"); await fs.unlink(lockFile); }
    } catch (error) { if (promoted) throw committedError(error); throw error; }
  }
}
async function verifyPrevalidatedKeywordMonthlyBundle({ projectionDir, expectedCatalogSha256, preparation, wantedScopes, checkpoint = null } = {}) {
  ensure(checkpoint === null || typeof checkpoint === "function", "KEYWORD_MONTHLY_BUNDLE_PREVALIDATION_INVALID");
  ensure(typeof projectionDir === "string" && path.isAbsolute(projectionDir) && SHA.test(expectedCatalogSha256 || "")
    && validPreparationShape(preparation)
    && Array.isArray(wantedScopes) && wantedScopes.length > 0 && wantedScopes.length <= LIMITS.scopes
    && wantedScopes.every(scope => exact(scope, ["keyword", "month"]) && keywordValid(scope.keyword) && MONTH.test(scope.month)),
  "KEYWORD_MONTHLY_BUNDLE_PREVALIDATION_INVALID");
  const loaded = await loadBundle(projectionDir), receiptRead = await readFile(path.join(loaded.generationDir, "publication-receipt.json"), 256 * 1024), receipt = json(receiptRead);
  ensure(loaded.catalogRead.sha256 === expectedCatalogSha256 && receipt.status === "published" && receipt.generation === loaded.pointer.generation
    && receipt.pointerSha256 === loaded.pointerRead.sha256 && receipt.catalogSha256 === loaded.catalogRead.sha256
    && receipt.fixedValidationClock === preparation.fixedValidationClock && receipt.semanticPrevalidationSha256 === hash(JSON.stringify(preparation))
    && receipt.publicationProjectionAnalyses === 0 && receipt.sourceProvenancePreserved === true && receipt.originalEnvelopesRewritten === false
    && receipt.providerCalls === 0 && receipt.collectorStarted === false && receipt.kosisReadOrChanged === false,
  "KEYWORD_MONTHLY_BUNDLE_PREVALIDATION_READBACK_FAILED");
  await exactDirectoryEntries(loaded.generationDir, ["catalog.json", "publication-receipt.json", "partitions", ...(preparation.schemaVersion === 2 ? ["results"] : [])], 4);
  await exactDirectoryEntries(path.join(loaded.generationDir, "partitions"), loaded.catalog.partitions.map(part => part.key), LIMITS.partitions);
  const expectedParts = new Map(), expectedScopes = [], seenScopes = new Set(), validations = new Map(), publishedParts = []; let totalStoredBytes = 0;
  for (const part of preparation.parts) {
    if (checkpoint) await checkpoint();
    ensure(plain(part) && SHA.test(part.index?.sha256 || "") && Array.isArray(part.exposed), "KEYWORD_MONTHLY_BUNDLE_PREVALIDATION_INVALID");
    const directory = path.join(loaded.generationDir, "partitions", part.index.sha256), adjusted = { ...part, directory, index: { ...part.index, file: path.join(directory, "index.json") } };
    const current = await inputPartition({ directory, exposeScopes: part.exposed }, preparation.fixedValidationClock, adjusted, null, checkpoint);
    publishedParts.push(current);
    if (!expectedParts.has(current.index.sha256)) {
      expectedParts.set(current.index.sha256, { key: current.index.sha256, indexSha256: current.index.sha256, indexBytes: current.index.size });
      totalStoredBytes += current.index.size + current.files.reduce((sum, file) => sum + file.bytes, 0);
      await exactDirectoryEntries(directory, ["index.json", "projections"], 2);
      await exactDirectoryEntries(path.join(directory, "projections"), current.files.map(file => file.name), CHILD_LIMITS.scopes);
    }
    for (const scope of current.exposed) {
      const id = scopeId(scope.keyword, scope.month); ensure(!seenScopes.has(id), "KEYWORD_MONTHLY_BUNDLE_SCOPE_CONFLICT"); seenScopes.add(id);
      expectedScopes.push({ ...scope, partition: current.index.sha256 });
      validations.set(id, { indexSha256: current.index.sha256, value: current.validation.find(row => row.query.keyword === scope.keyword && row.query.month === scope.month) });
    }
  }
  let expectedCatalog = { schemaVersion: 1, kind: "keyword_monthly_partition_bundle", createdAt: new Date(preparation.fixedValidationClock).toISOString(),
    partitions: [...expectedParts.values()], scopes: expectedScopes.sort((a, b) => scopeId(a.keyword, a.month).localeCompare(scopeId(b.keyword, b.month))) };
  if (preparation.schemaVersion === 2) {
    // Recovery never needs the removed disposable child namespace. Bind the
    // unchanged attestation, then inspect the exact committed published files.
    const saved = await preparedMetadata({ ...preparation, preparedResults: { ...preparation.preparedResults, directory: path.join(loaded.generationDir, "results") } }, publishedParts, checkpoint);
    expectedCatalog = { ...expectedCatalog, schemaVersion: 2, preparedResults: saved.descriptors };
    totalStoredBytes += saved.descriptors.reduce((sum, descriptor) => sum + descriptor.bytes, 0);
    ensure(receipt.preparedResultCount === saved.descriptors.length && receipt.calculationFingerprint === saved.calculationFingerprint, "KEYWORD_MONTHLY_BUNDLE_PREVALIDATION_READBACK_FAILED");
  }
  ensure(JSON.stringify(loaded.catalog) === JSON.stringify(expectedCatalog) && receipt.partitionCount === expectedParts.size
    && receipt.totalStoredBytes === totalStoredBytes && totalStoredBytes <= preparation.maxTotalBytes
    && receipt.scopeCount === expectedScopes.length && JSON.stringify(receipt.partitions) === JSON.stringify(preparation.parts.map(part => ({ inputIndexSha256: part.index.sha256, inputIndexBytes: part.index.size, validation: part.validation }))),
  "KEYWORD_MONTHLY_BUNDLE_PREVALIDATION_READBACK_FAILED");
  const scopes = [], wantedIds = new Set();
  for (const wanted of wantedScopes) {
    const id = scopeId(wanted.keyword, wanted.month), validated = validations.get(id); ensure(validated && !wantedIds.has(id), "KEYWORD_MONTHLY_BUNDLE_PREVALIDATION_READBACK_FAILED"); wantedIds.add(id);
    const row = validated.value, query = row.query;
    scopes.push({ ...query, resultId: hash(JSON.stringify([loaded.pointerRead.sha256, loaded.catalogRead.sha256, validated.indexSha256, query])),
      inputSha256: row.inputSha256, dataThrough: row.dataThrough, selectedDigest: row.selectedDigest, status: row.status });
  }
  ensure((await loadBundle(projectionDir)).pointerRead.sha256 === loaded.pointerRead.sha256, "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ");
  return { generation: loaded.pointer.generation, pointerSha256: loaded.pointerRead.sha256, catalogSha256: loaded.catalogRead.sha256,
    publicationReceiptSha256: receiptRead.sha256, scopeCount: loaded.catalog.scopes.length, scopes,
    verificationBasis: "attested_semantic_validation_and_exact_published_bytes", semanticValidationClock: preparation.fixedValidationClock, readbackProjectionAnalyses: 0 };
}
module.exports = { createKeywordMonthlyBundleAnalysis, publishKeywordMonthlyBundle, prepareKeywordMonthlyBundle, publishPrevalidatedKeywordMonthlyBundle, verifyPrevalidatedKeywordMonthlyBundle, validateCatalog, validatePointer, loadBundle, composeOptions, readBundleFile: readFile, KEYWORD_MONTHLY_BUNDLE_LIMITS: LIMITS };
