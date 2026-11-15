"use strict";
// Explicit preparation and immutable derived partitions only. No application,
// source adapter, collector, provider, queue, credentials or KOSIS dependency.
const fs = require("node:fs/promises");
const C = require("node:fs").constants;
const path = require("node:path");
const crypto = require("node:crypto");
const { createKeywordMonthlyAnalysis, createKeywordMonthlyOptionsIndexReader, KEYWORD_MONTHLY_LIMITS: CHILD_LIMITS } = require("./keyword_monthly_analysis.cjs");
const { getAnalyticalPhaseDiagnostics } = require("./analytical_phase_runtime.cjs");
const { runKeywordMonthlyMemoryAdmission, keywordMonthlyAllocationCheckpoint } = require("./keyword_monthly_memory_admission.cjs");
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
const sameStat = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].every(key => a[key] === b[key]);
const keywordValid = value => typeof value === "string" && value.length > 0 && value.length <= 300 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const iso = value => typeof value === "string" && /^20\d{2}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))
  && new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);
const scopeId = (keyword, month) => JSON.stringify([keyword, month]);
function fault(code, statusCode = 503) { return Object.assign(new Error(code), { code, statusCode }); }
function ensure(value, code, statusCode = 503) { if (!value) throw fault(code, statusCode); }
async function checkPath(file, directory = false) {
  const absolute = path.resolve(file), root = path.parse(absolute).root; let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const stat = await fs.lstat(current);
    ensure(!stat.isSymbolicLink() && samePath(await fs.realpath(current), current) && (current === absolute || stat.isDirectory()), "KEYWORD_MONTHLY_BUNDLE_UNSAFE_PATH");
  }
  const stat = await fs.lstat(absolute); ensure(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, "KEYWORD_MONTHLY_BUNDLE_UNSAFE_PATH"); return stat;
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
function createKeywordMonthlyBundleAnalysis({ projectionDir, now = () => Date.now(), staleAfterMs, measure = measureDefault,
  runLegacyAnalysis = runKeywordMonthlyMemoryAdmission } = {}) {
  ensure(typeof projectionDir === "string" && path.isAbsolute(projectionDir), "KEYWORD_MONTHLY_BUNDLE_ABSOLUTE_DIRECTORY_REQUIRED");
  if (typeof runLegacyAnalysis !== "function") throw new TypeError("A guarded legacy analysis callback is required");
  const directory = path.resolve(projectionDir), legacy = createKeywordMonthlyAnalysis({ projectionDir: directory, now, measure, ...(staleAfterMs === undefined ? {} : { staleAfterMs }) });
  const optionsReader = createKeywordMonthlyOptionsIndexReader({ now, measure, ...(staleAfterMs === undefined ? {} : { staleAfterMs }) });
  const optionsFlights = new Map();
  const basic = () => { const currentDay = new Date(new Date(now()).getTime() + 9 * 3600000).toISOString().slice(0, 10); return { schemaVersion: 1, readOnly: true, networkAttempted: false, currentDay, currentMonth: currentDay.slice(0, 7) }; };
  const absent = (error, request) => ({ ...basic(), status: "needs_verification", ...(request ? { request, snapshot: null } : { keywords: [] }), diagnostics: [safeError(error)], provenance: null, activity: null, latestAttempt: null, lastSuccessfulAttempt: null });
  async function open() { try { return await loadBundle(directory); } catch (error) { if (error.code === "ENOENT") {
      // Only a genuinely absent pointer permits the unchanged legacy reader.
      try { await fs.lstat(path.join(directory, "current.json")); } catch (missing) { if (missing.code === "ENOENT") return null; throw missing; }
    } throw error; } }
  async function legacyRead(operation) {
    const result = await operation();
    try { await fs.lstat(path.join(directory, "current.json")); throw fault("KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return result;
  }
  async function unchanged(bundle, part) {
    const after = await loadBundle(directory); ensure(after.pointerRead.sha256 === bundle.pointerRead.sha256 && after.catalogRead.sha256 === bundle.catalogRead.sha256, "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ");
    for (const item of part ? Array.isArray(part) ? part : [part] : []) {
      const index = await measure("keyword_index_read", { readCount: 1, inputBytes: item.index.size }, () => readFile(path.join(item.directory, "index.json"), CHILD_LIMITS.indexBytes));
      ensure(index.sha256 === item.index.sha256 && index.size === item.index.size, "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ");
    }
    // A publication during the final index pass cannot return the old generation.
    const final = await readFile(path.join(directory, "current.json"), LIMITS.pointerBytes);
    ensure(final.sha256 === bundle.pointerRead.sha256, "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ");
  }
  async function loadOptions(bundle) {
    const parts = new Map(), failures = [];
    for (const descriptor of bundle.catalog.partitions) {
      try { parts.set(descriptor.key, await partition(bundle, descriptor.key, now, staleAfterMs, { optionsReader, measure, verifyAfter: false })); }
      catch (error) { failures.push({ partition: descriptor.key, code: safeError(error) }); }
    }
    // The final pass retains all index and pointer race checks, instead of
    // reparsing each index through a second child service before this pass.
    await unchanged(bundle, [...parts.values()]);
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
  return Object.freeze({ options, readPrepared, analyze });
}
async function ensureDirectory(directory) {
  try { await checkPath(directory, true); } catch (error) { if (error.code !== "ENOENT") throw error; await checkPath(path.dirname(directory), true); await fs.mkdir(directory, { mode: 0o700 }); await checkPath(directory, true); }
}
async function inputPartition(input, now, { prepareResults = false } = {}) {
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
    ensure(SHA.test(scope.scopeKey) && SHA.test(scope.sha256) && Number.isSafeInteger(scope.bytes) && scope.bytes > 0 && scope.bytes <= CHILD_LIMITS.projectionBytes, "KEYWORD_MONTHLY_BUNDLE_INPUT_SCOPE");
    const name = `${scope.scopeKey}.json${scope.encoding === "gzip" ? ".gz" : ""}`;
    const read = await readFile(path.join(directory, "projections", name), CHILD_LIMITS.projectionBytes);
    ensure(read.sha256 === scope.sha256 && read.size === scope.bytes, "KEYWORD_MONTHLY_BUNDLE_INPUT_PROJECTION_MISMATCH"); files.push({ name, sha256: read.sha256, bytes: read.size });
  }
  const validation = [];
  for (const scope of prepareResults ? [] : exposed) {
    const item = options.keywords.find(row => row.keyword === scope.keyword), query = { ...scope, cutoffDate: item.defaultCutoffs[scope.month] }, result = await service.analyze(query);
    if (!(["available", "stale"].includes(result.status) && result.snapshot && result.request.keyword === query.keyword && result.request.month === query.month && result.request.cutoffDate === query.cutoffDate && SHA.test(result.snapshot.sources?.digest || ""))) throw Object.assign(fault("KEYWORD_MONTHLY_BUNDLE_INPUT_ANALYSIS_FAILED"), { scope: query, inputStatus: result.status, diagnostics: result.diagnostics });
    validation.push({ query, status: result.status, selectedDigest: result.snapshot.sources.digest, inputSha256: result.provenance.inputSha256, dataThrough: result.provenance.dataThrough });
  }
  ensure((await readFile(path.join(directory, "index.json"), CHILD_LIMITS.indexBytes)).sha256 === index.sha256, "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ");
  return { directory, index: { file: index.file, sha256: index.sha256, size: index.size }, exposed, files, validation, options: narrowOptions(options, exposed) };
}
async function publishKeywordMonthlyBundle({ inputs, outputDir, now, expectedCurrentSha256 = null, maxTotalBytes = LIMITS.defaultTotalBytes,
  beforePromote, prepareResults = false, preparedQueries = [] } = {}) {
  ensure(Array.isArray(inputs) && inputs.length > 0 && inputs.length <= LIMITS.partitions && typeof outputDir === "string" && path.isAbsolute(outputDir) && iso(now), "KEYWORD_MONTHLY_BUNDLE_BUILD_INPUT");
  ensure(typeof prepareResults === "boolean" && Array.isArray(preparedQueries) && preparedQueries.length <= RESULT_LIMITS.results
    && (prepareResults || preparedQueries.length === 0), "KEYWORD_MONTHLY_RESULT_BUILD_INVALID");
  const preparedQueryIds = new Set();
  for (const query of preparedQueries) {
    ensure(exact(query, ["keyword", "month", "cutoffDate"]) && keywordValid(query.keyword) && MONTH.test(query.month)
      && typeof query.cutoffDate === "string" && /^20\d{2}-\d\d-\d\d$/.test(query.cutoffDate)
      && Number.isFinite(Date.parse(`${query.cutoffDate}T00:00:00Z`)) && new Date(`${query.cutoffDate}T00:00:00Z`).toISOString().slice(0, 10) === query.cutoffDate
      && !preparedQueryIds.has(queryId(query)), "KEYWORD_MONTHLY_RESULT_QUERY_INVALID");
    preparedQueryIds.add(queryId(query));
  }
  ensure(Number.isSafeInteger(maxTotalBytes) && maxTotalBytes > 0 && maxTotalBytes <= 8 * 1024 * 1024 * 1024, "KEYWORD_MONTHLY_BUNDLE_TOTAL_BOUND");
  ensure(expectedCurrentSha256 === null || SHA.test(expectedCurrentSha256), "KEYWORD_MONTHLY_BUNDLE_EXPECTED_POINTER");
  const prepared = []; for (const input of inputs) prepared.push(await inputPartition(input, now, { prepareResults }));
  const partitions = new Map(), scopes = [], seen = new Set(); let totalBytes = 0;
  for (const part of prepared) {
    if (!partitions.has(part.index.sha256)) { partitions.set(part.index.sha256, part); totalBytes += part.index.size + part.files.reduce((sum, file) => sum + file.bytes, 0); }
    for (const scope of part.exposed) { const id = scopeId(scope.keyword, scope.month); ensure(!seen.has(id), "KEYWORD_MONTHLY_BUNDLE_SCOPE_CONFLICT"); seen.add(id); scopes.push({ ...scope, partition: part.index.sha256 }); }
  }
  ensure(scopes.length <= LIMITS.scopes && totalBytes <= maxTotalBytes, "KEYWORD_MONTHLY_BUNDLE_TOTAL_BOUND");
  ensure(preparedQueries.every(query => scopes.some(scope => scope.keyword === query.keyword && scope.month === query.month)), "KEYWORD_MONTHLY_RESULT_QUERY_UNEXPOSED");
  let catalog = validateCatalog({ schemaVersion: 1, kind: "keyword_monthly_partition_bundle", createdAt: new Date(now).toISOString(),
    partitions: [...partitions].map(([key, part]) => ({ key, indexSha256: key, indexBytes: part.index.size })), scopes: scopes.sort((a, b) => scopeId(a.keyword, a.month).localeCompare(scopeId(b.keyword, b.month))) });
  let catalogBytes = Buffer.from(JSON.stringify(catalog)); ensure(catalogBytes.length <= LIMITS.catalogBytes, "KEYWORD_MONTHLY_BUNDLE_SIZE_LIMIT");
  const scopePlanSha256 = hash(catalogBytes);
  // Recombine a repeated identical input index's explicit subsets before the
  // exact same options-size check used by the runtime reader.
  for (const [key, part] of partitions) {
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
    for (const file of part.files) { const read = await readFile(path.join(part.directory, "projections", file.name), CHILD_LIMITS.projectionBytes); ensure(read.sha256 === file.sha256 && read.size === file.bytes, "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ"); await fs.writeFile(path.join(target, "projections", file.name), read.bytes, { flag: "wx", mode: 0o600 }); const copied = await readFile(path.join(target, "projections", file.name), CHILD_LIMITS.projectionBytes); ensure(copied.sha256 === file.sha256 && copied.size === file.bytes, "KEYWORD_MONTHLY_BUNDLE_COPY_MISMATCH"); }
    const index = await readFile(path.join(part.directory, "index.json"), CHILD_LIMITS.indexBytes); ensure(index.sha256 === key && index.size === part.index.size, "KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ"); await fs.writeFile(path.join(target, "index.json"), index.bytes, { flag: "wx", mode: 0o600 });
  }
  if (prepareResults) {
    const resultDir = path.join(generationDir, "results"); await fs.mkdir(resultDir, { mode: 0o700 });
    const results = [];
    // Compute and write one final payload at a time. Do not retain a second
    // all-scope snapshot graph or an all-scope encoded-result buffer cache.
    for (const [key, part] of partitions) {
      const service = createKeywordMonthlyAnalysis({ projectionDir: path.join(generationDir, "partitions", key), now: () => now });
      const queries = new Map();
      for (const scope of scopes.filter(scope => scope.partition === key)) {
        const item = part.options.keywords.find(row => row.keyword === scope.keyword), query = { keyword: scope.keyword, month: scope.month, cutoffDate: item.defaultCutoffs[scope.month] };
        queries.set(queryId(query), query);
      }
      for (const query of preparedQueries.filter(query => scopes.some(scope => scope.partition === key && scope.keyword === query.keyword && scope.month === query.month))) queries.set(queryId(query), query);
      ensure(results.length + queries.size <= RESULT_LIMITS.results, "KEYWORD_MONTHLY_RESULT_CATALOG_BOUND");
      for (const query of queries.values()) {
        const result = await service.analyze(query);
        if (!(["available", "stale"].includes(result.status) && result.snapshot && queryId(result.request) === queryId(query))) throw Object.assign(fault("KEYWORD_MONTHLY_BUNDLE_INPUT_ANALYSIS_FAILED"), { scope: query, inputStatus: result.status, diagnostics: result.diagnostics });
        const saved = encodePreparedResult(result, { partition: key });
        totalBytes += saved.bytes.length; ensure(totalBytes <= maxTotalBytes, "KEYWORD_MONTHLY_BUNDLE_TOTAL_BOUND");
        const file = path.join(resultDir, `${saved.descriptor.sha256}.json${saved.descriptor.encoding === "gzip" ? ".gz" : ""}`);
        await fs.writeFile(file, saved.bytes, { flag: "wx", mode: 0o600 });
        const copied = await readFile(file, RESULT_LIMITS.encodedBytes); ensure(copied.sha256 === saved.descriptor.sha256 && copied.size === saved.descriptor.bytes, "KEYWORD_MONTHLY_RESULT_COPY_MISMATCH");
        results.push(saved.descriptor);
        part.validation.push({ query, status: result.status, selectedDigest: result.snapshot.sources.digest, inputSha256: result.provenance.inputSha256, dataThrough: result.provenance.dataThrough });
      }
    }
    catalog = validateCatalog({ ...catalog, schemaVersion: 2, preparedResults: results.sort((a, b) => queryId(a).localeCompare(queryId(b))) });
    catalogBytes = Buffer.from(JSON.stringify(catalog)); ensure(catalogBytes.length <= LIMITS.catalogBytes, "KEYWORD_MONTHLY_BUNDLE_SIZE_LIMIT");
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
      preparedResultCount: catalog.preparedResults?.length || 0, ...(prepareResults ? { calculationFingerprint: calculationFingerprint() } : {}) }));
    const finalCatalog = await readFile(path.join(generationDir, "catalog.json"), LIMITS.catalogBytes);
    ensure(finalCatalog.sha256 === pointer.catalogSha256 && finalCatalog.size === catalogBytes.length, "KEYWORD_MONTHLY_BUNDLE_CHANGED_BEFORE_PROMOTION");
    for (const [key, part] of partitions) {
      const finalIndex = await readFile(path.join(generationDir, "partitions", key, "index.json"), CHILD_LIMITS.indexBytes);
      ensure(finalIndex.sha256 === key && finalIndex.size === part.index.size, "KEYWORD_MONTHLY_BUNDLE_CHANGED_BEFORE_PROMOTION");
    }
    if (prepareResults) for (const result of catalog.preparedResults) {
      const saved = await readFile(path.join(generationDir, "results", `${result.sha256}.json${result.encoding === "gzip" ? ".gz" : ""}`), RESULT_LIMITS.encodedBytes);
      ensure(saved.sha256 === result.sha256 && saved.size === result.bytes, "KEYWORD_MONTHLY_RESULT_CHANGED_BEFORE_PROMOTION");
    }
    const temporary = path.join(directory, `.current-${generation}.tmp`), handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(pointerBytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, path.join(directory, "current.json"));
    promoted = true;
    const readback = await loadBundle(directory); ensure(readback.pointerRead.sha256 === hash(pointerBytes) && readback.catalogRead.sha256 === pointer.catalogSha256, "KEYWORD_MONTHLY_BUNDLE_PUBLICATION_READBACK");
    const receipt = { schemaVersion: 1, status: "published", generation, bundleDir: directory, totalStoredBytes: totalBytes, pointerSha256: hash(pointerBytes), previousPointerSha256: previous?.sha256 || null,
      catalogSha256: pointer.catalogSha256, partitionCount: partitions.size, scopeCount: scopes.length, fixedValidationClock: new Date(now).toISOString(),
      ...(prepareResults ? { preparedResultCount: catalog.preparedResults.length, calculationFingerprint: calculationFingerprint() } : {}),
      partitions: prepared.map(part => ({ inputIndexSha256: part.index.sha256, inputIndexBytes: part.index.size, validation: part.validation })),
      sourceProvenancePreserved: true, originalEnvelopesRewritten: false, providerCalls: 0, collectorStarted: false, kosisReadOrChanged: false,
      freshnessPolicy: "Original child materializedAt/dataThrough/status retained; bundle assembly never refreshes historical source provenance." };
    await fs.writeFile(path.join(generationDir, "publication-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 }); return receipt;
  } catch (error) { if (promoted) throw committedError(error); throw error; }
  finally {
    try { await lock.close();
      if (lockStamp) { const stat = await checkPath(lockFile), current = await readFile(lockFile, LIMITS.pointerBytes); ensure(sameStat(stat, lockStamp) && current.sha256 === hash(lockBytes), "KEYWORD_MONTHLY_BUNDLE_LOCK_CHANGED"); await fs.unlink(lockFile); }
    } catch (error) { if (promoted) throw committedError(error); throw error; }
  }
}
module.exports = { createKeywordMonthlyBundleAnalysis, publishKeywordMonthlyBundle, validateCatalog, validatePointer, loadBundle, composeOptions, readBundleFile: readFile, KEYWORD_MONTHLY_BUNDLE_LIMITS: LIMITS };
