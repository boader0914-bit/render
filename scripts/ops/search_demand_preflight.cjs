"use strict";

// Explicit one-off verification only. Importing this file does not read keys,
// create files, start an application, schedule work, or contact a provider.
const fs = require("node:fs/promises"), constants = require("node:fs").constants;
const path = require("node:path"), crypto = require("node:crypto"), vm = require("node:vm"), zlib = require("node:zlib");
const FILES = Object.freeze(["naver_datalab_connection.cjs", "search_demand_model.cjs", "search_demand_providers.cjs",
  "search_demand_store.cjs", "search_demand_forecast.cjs", "search_demand_service.cjs"].map(name => "scripts/lib/" + name));
const BUILTINS = new Set(["node:crypto", "node:fs", "node:fs/promises", "node:path"]);
const MAX = Object.freeze({ plan: 32768, key: 65536, source: 524288, receipt: 65536, evidence: 16 * 1024 * 1024, gzip: 4 * 1024 * 1024 });
const KEYWORD = "경남글램핑", SHA = /^[a-f0-9]{64}$/;
const code = value => /^PREFLIGHT_[A-Z0-9_]{1,80}$/.test(value || "") ? value : "PREFLIGHT_FAILED";
const failure = value => Object.assign(new Error("한정 검색수요 검증 근거를 확인해 주세요."), { code: value });
const need = (condition, value) => { if (!condition) throw failure(value); };
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const canonical = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const plain = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const same = (a, b) => ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"].every(key => a[key] === b[key]);
function absolute(value) { return typeof value === "string" && path.isAbsolute(value); }
function iso(clock) { const value = new Date(clock()); need(Number.isFinite(value.getTime()), "PREFLIGHT_CLOCK_INVALID"); return value.toISOString(); }

async function parents(file, create = false) {
  need(absolute(file), "PREFLIGHT_PATH_UNSAFE");
  const parent = path.dirname(path.resolve(file)), parsed = path.parse(parent), entries = [];
  let current = parsed.root;
  for (const part of ["", ...parent.slice(parsed.root.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current, { bigint: true }); }
    catch (error) {
      if (!create || error.code !== "ENOENT") throw error;
      try { await fs.mkdir(current, { mode: 0o700 }); } catch (other) { if (other.code !== "EEXIST") throw other; }
      stat = await fs.lstat(current, { bigint: true });
    }
    const real = await fs.realpath(current);
    need(stat.isDirectory() && !stat.isSymbolicLink() && canonical(real) === canonical(current), "PREFLIGHT_PATH_UNSAFE");
    entries.push({ file: current, stat, real });
  }
  return entries;
}
async function checkParents(entries) {
  for (const entry of entries) {
    const stat = await fs.lstat(entry.file, { bigint: true }), real = await fs.realpath(entry.file);
    need(stat.isDirectory() && !stat.isSymbolicLink() && canonical(real) === canonical(entry.file), "PREFLIGHT_PATH_UNSAFE");
    need(["dev", "ino", "mode"].every(key => stat[key] === entry.stat[key]) && real === entry.real, "PREFLIGHT_EVIDENCE_CHANGED");
  }
}
async function readBytes(file, maximum) {
  let handle;
  const entries = await parents(file);
  try {
    const before = await fs.lstat(file, { bigint: true });
    need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(maximum)
      && canonical(await fs.realpath(file)) === canonical(file), "PREFLIGHT_FILE_UNSAFE");
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    need(same(before, await handle.stat({ bigint: true })), "PREFLIGHT_EVIDENCE_CHANGED");
    const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < bytes.length) { const chunk = await handle.read(bytes, length, bytes.length - length, length); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
    need(length === Number(before.size) && same(before, await handle.stat({ bigint: true })) && same(before, await fs.lstat(file, { bigint: true })), "PREFLIGHT_EVIDENCE_CHANGED");
    await checkParents(entries); return bytes.subarray(0, length);
  } finally { await handle?.close(); }
}
async function readJson(file, maximum, optional = false) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBytes(file, maximum))); }
  catch (error) { if (optional && error.code === "ENOENT") return null; throw /^PREFLIGHT_/.test(error.code || "") ? error : failure("PREFLIGHT_JSON_UNREADABLE"); }
}
async function immutable(file, bytes, maximum) {
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum, "PREFLIGHT_WRITE_BOUNDS");
  const entries = await parents(file, true); let handle;
  try {
    handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    await handle.writeFile(bytes); await handle.sync();
  } finally { await handle?.close(); }
  await checkParents(entries);
  const readback = await readBytes(file, maximum);
  need(readback.equals(bytes), "PREFLIGHT_WRITE_READBACK_FAILED");
  return { path: file, bytes: readback.length, sha256: digest(readback) };
}
const jsonBytes = value => Buffer.from(JSON.stringify(value) + "\n");

async function buildPreflightPlan({ sourceRoot, operationRoot, keyFile, keyword = KEYWORD, startDate = "2025-11-01", endDate = "2026-10-31", credentialMode = "effective" } = {}) {
  need(absolute(sourceRoot) && absolute(operationRoot) && absolute(keyFile) && keyword === KEYWORD, "PREFLIGHT_PLAN_INVALID");
  const files = [];
  for (const relative of FILES) { const bytes = await readBytes(path.join(sourceRoot, relative), MAX.source); files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) }); }
  return { schemaVersion: 1, purpose: "gyeongnam-search-demand-release-preflight", keyword, operationRoot: path.resolve(operationRoot),
    codeRoot: path.join(path.resolve(operationRoot), "code"), keyFile: path.resolve(keyFile), credentialMode,
    requestWindow: { startDate, endDate, timeUnit: "month", expectedMonths: 12 }, expectedRequests: { searchad: 1, datalab: 1 },
    connectionProvider: "ncp_apihub", files };
}
function validatePlan(plan) {
  need(plain(plan) && plan.schemaVersion === 1 && plan.purpose === "gyeongnam-search-demand-release-preflight" && plan.keyword === KEYWORD
    && absolute(plan.operationRoot) && absolute(plan.codeRoot) && absolute(plan.keyFile) && canonical(plan.codeRoot) === canonical(path.join(plan.operationRoot, "code"))
    && path.basename(plan.keyFile) === "traffic_api_keys.local.json" && ["effective", "file_only"].includes(plan.credentialMode)
    && plan.connectionProvider === "ncp_apihub" && plan.expectedRequests?.searchad === 1 && plan.expectedRequests?.datalab === 1
    && plan.requestWindow?.startDate === "2025-11-01" && plan.requestWindow?.endDate === "2026-10-31"
    && plan.requestWindow?.timeUnit === "month" && plan.requestWindow?.expectedMonths === 12
    && Array.isArray(plan.files) && plan.files.length === FILES.length && new Set(plan.files.map(item => item.path)).size === FILES.length
    && plan.files.every(item => FILES.includes(item.path) && Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= MAX.source && SHA.test(item.sha256)), "PREFLIGHT_PLAN_INVALID");
}
async function loadPinnedModules(plan) {
  const source = new Map(), loaded = new Map();
  for (const pin of plan.files) {
    const bytes = await readBytes(path.join(plan.codeRoot, pin.path), MAX.source);
    need(bytes.length === pin.bytes && digest(bytes) === pin.sha256, "PREFLIGHT_SOURCE_SHA_MISMATCH");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    need(!/\brequire\s*\(\s*[^'"\s]/.test(text) && !/\bimport\s*\(/.test(text), "PREFLIGHT_DEPENDENCY_UNSAFE");
    for (const match of text.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      const target = match[1].startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(pin.path), match[1])) : match[1];
      need(BUILTINS.has(target) || FILES.includes(target), "PREFLIGHT_DEPENDENCY_UNSAFE");
    }
    source.set(pin.path, text);
  }
  function load(relative) {
    if (loaded.has(relative)) return loaded.get(relative).exports;
    need(source.has(relative), "PREFLIGHT_DEPENDENCY_UNSAFE");
    const module_ = { exports: {} }; loaded.set(relative, module_);
    const require_ = name => BUILTINS.has(name) ? require(name) : load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), name)));
    const wrapped = new vm.Script("(function(exports, require, module, __filename, __dirname){\n" + source.get(relative) + "\n})", { filename: relative });
    wrapped.runInThisContext()(module_.exports, require_, module_, path.join(plan.codeRoot, relative), path.dirname(path.join(plan.codeRoot, relative)));
    return module_.exports;
  }
  return { model: load("scripts/lib/search_demand_model.cjs"), providers: load("scripts/lib/search_demand_providers.cjs"),
    store: load("scripts/lib/search_demand_store.cjs"), service: load("scripts/lib/search_demand_service.cjs"), forecast: load("scripts/lib/search_demand_forecast.cjs") };
}
async function memoryKeys(plan, environment) {
  const saved = await readJson(plan.keyFile, MAX.key);
  need(plain(saved), "PREFLIGHT_KEY_SOURCE_INVALID");
  const env = plan.credentialMode === "effective" ? environment : {};
  const normalize = value => typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
  const keys = {
    datalabProvider: env.NAVER_DATALAB_PROVIDER !== undefined ? env.NAVER_DATALAB_PROVIDER : Object.hasOwn(saved, "datalabProvider") ? saved.datalabProvider : "developers",
    ncpApihubClientId: normalize(env.NAVER_API_HUB_CLIENT_ID || saved.ncpApihubClientId || ""),
    ncpApihubClientSecret: normalize(env.NAVER_API_HUB_CLIENT_SECRET || saved.ncpApihubClientSecret || ""),
    searchadApiKey: normalize(env.NAVER_SEARCHAD_API_KEY || saved.searchadApiKey || ""),
    searchadSecretKey: normalize(env.NAVER_SEARCHAD_SECRET_KEY || saved.searchadSecretKey || ""),
    searchadCustomerId: normalize(env.NAVER_SEARCHAD_CUSTOMER_ID || saved.searchadCustomerId || "")
  };
  need(keys.datalabProvider === "ncp_apihub", "PREFLIGHT_NCP_NOT_SELECTED");
  need(["ncpApihubClientId", "ncpApihubClientSecret", "searchadApiKey", "searchadSecretKey", "searchadCustomerId"].every(field => keys[field]), "PREFLIGHT_KEYS_MISSING");
  return keys;
}
function requestGate(plan, fetchImpl, counts) {
  return async (url, options) => {
    let target, provider;
    try { target = new URL(url); } catch { throw failure("PREFLIGHT_REQUEST_DENIED"); }
    need(target.protocol === "https:" && !target.username && !target.password && !target.hash && options.redirect === "error" && options.signal, "PREFLIGHT_REQUEST_DENIED");
    if (target.host === "api.searchad.naver.com" && target.pathname === "/keywordstool") {
      provider = "searchad";
      need(options.method === "GET" && !options.body && target.searchParams.size === 2 && target.searchParams.get("hintKeywords") === plan.keyword
        && target.searchParams.get("showDetail") === "1", "PREFLIGHT_REQUEST_DENIED");
    } else if (target.host === "naverapihub.apigw.ntruss.com" && target.pathname === "/search-trend/v1/search") {
      provider = "datalab"; let body;
      try { body = JSON.parse(options.body); } catch { throw failure("PREFLIGHT_REQUEST_DENIED"); }
      need(options.method === "POST" && !target.search && body.startDate === plan.requestWindow.startDate && body.endDate === plan.requestWindow.endDate
        && body.timeUnit === "month" && Array.isArray(body.keywordGroups) && body.keywordGroups.length === 1
        && body.keywordGroups[0].groupName === plan.keyword && Array.isArray(body.keywordGroups[0].keywords)
        && body.keywordGroups[0].keywords.length === 1 && body.keywordGroups[0].keywords[0] === plan.keyword, "PREFLIGHT_REQUEST_DENIED");
    } else throw failure("PREFLIGHT_REQUEST_DENIED");
    need(counts[provider] < 1, "PREFLIGHT_REQUEST_LIMIT"); counts[provider]++;
    return fetchImpl(url, options);
  };
}
function safeResult(result) {
  return { provider: result.provider, status: result.status, errorCode: /^[A-Z][A-Z0-9_]{1,99}$/.test(result.errorCode || "") ? result.errorCode : null,
    httpStatus: Number.isInteger(result.httpStatus) ? result.httpStatus : null, networkAttempted: result.networkAttempted === true,
    requestCount: [0, 1].includes(result.requestCount) ? result.requestCount : null, requestedAt: result.requestedAt || null, observedAt: result.observedAt || null,
    responseBytes: Number.isSafeInteger(result.diagnostics?.responseBytes) ? result.diagnostics.responseBytes : null, snapshotId: result.snapshot?.snapshotId || null };
}
function publicSnapshot(snapshot, model) {
  if (!snapshot) return null;
  return { ...model.safeMetadata(snapshot), ...(snapshot.provider === "searchad" ? { anchor: model.publicRow(snapshot.anchor),
    rows: snapshot.rows.map(model.publicRow), observations: snapshot.observations.map(model.publicRow) }
    : { series: snapshot.series, coverage: snapshot.coverage, timeUnit: snapshot.timeUnit }) };
}

async function executePreflight({ planFile, planSha256, executeLive = false, fetchImpl = globalThis.fetch, clock = Date.now, credentialEnvironment = {} } = {}) {
  need(absolute(planFile) && SHA.test(planSha256 || "") && typeof executeLive === "boolean" && typeof clock === "function", "PREFLIGHT_ARGUMENT_INVALID");
  const planBytes = await readBytes(planFile, MAX.plan); need(digest(planBytes) === planSha256, "PREFLIGHT_PLAN_SHA_MISMATCH");
  let plan; try { plan = JSON.parse(planBytes.toString("utf8")); } catch { throw failure("PREFLIGHT_PLAN_INVALID"); }
  validatePlan(plan); const modules = await loadPinnedModules(plan);
  const storeRoot = path.join(plan.operationRoot, "validation-store"), receiptFile = path.join(plan.operationRoot, "execution-result.json"), claimFile = path.join(plan.operationRoot, "execution.claim.json");
  const evidenceFile = path.join(plan.operationRoot, "safe-evidence.json.gz");
  const store = modules.store.createSearchDemandStore({ rootDir: storeRoot, clock });
  const previous = await readJson(receiptFile, MAX.receipt, true);
  if (previous) {
    need(previous.schemaVersion === 1 && previous.planSha256 === planSha256, "PREFLIGHT_RECEIPT_MISMATCH");
    for (const id of previous.snapshotIds || []) need(await store.readSnapshot({ snapshotId: id }), "PREFLIGHT_STORED_SNAPSHOT_MISSING");
    const bytes = await readBytes(evidenceFile, MAX.gzip);
    need(digest(bytes) === previous.artifact.sha256 && bytes.length === previous.artifact.bytes, "PREFLIGHT_EVIDENCE_CHANGED");
    return { ...previous, reusedExistingEvidence: true, newRequestCounts: { searchad: 0, datalab: 0 }, credentialValuesExposed: false };
  }
  if (!executeLive) return { schemaVersion: 1, status: "ready_for_explicit_execution", planSha256, sourcePinsVerified: true,
    newRequestCounts: { searchad: 0, datalab: 0 }, keySourceRead: false, operatingWrites: false };
  need(typeof fetchImpl === "function", "PREFLIGHT_FETCH_UNAVAILABLE");
  const interrupted = await readJson(claimFile, MAX.receipt, true);
  if (interrupted) return { schemaVersion: 1, status: "needs_verification", errorCode: "PREFLIGHT_EXISTING_CLAIM", planSha256,
    newRequestCounts: { searchad: 0, datalab: 0 }, previousRequestCounts: null, credentialValuesExposed: false };
  const keys = await memoryKeys(plan, credentialEnvironment), startedAt = iso(clock), counts = { searchad: 0, datalab: 0 }, results = [], snapshots = [], duplicateChecks = [];
  await immutable(claimFile, jsonBytes({ schemaVersion: 1, planSha256, startedAt, keyword: plan.keyword, expectedRequests: plan.expectedRequests }), MAX.receipt);
  let errorCode = null, forecast = null, analysis = null;
  try {
    const providers = modules.providers.createSearchDemandProviders({ readKeys: async () => keys, fetchImpl: requestGate(plan, fetchImpl, counts), clock });
    for (const provider of ["searchad", "datalab"]) {
      const result = await providers[provider]({ keyword: plan.keyword, ...(provider === "datalab" ? { startDate: plan.requestWindow.startDate, endDate: plan.requestWindow.endDate } : {}) });
      results.push(safeResult(result));
      if (result.snapshot) {
        modules.model.validateSnapshot(result.snapshot);
        const first = await store.saveSnapshot(result.snapshot), second = await store.saveSnapshot(result.snapshot), readback = await store.readSnapshot({ snapshotId: result.snapshot.snapshotId });
        need(first.snapshotId === result.snapshot.snapshotId && second.snapshotId === first.snapshotId && second.reused === true && second.created === false
          && readback?.snapshotId === first.snapshotId, "PREFLIGHT_DUPLICATE_CHECK_FAILED");
        snapshots.push(result.snapshot); duplicateChecks.push({ provider, snapshotId: first.snapshotId, reused: true, createdOnDuplicate: false });
      }
      if (result.status !== "complete" || !result.snapshot || !result.snapshot.counts?.reconciled || result.snapshot.counts.invalidRows || result.snapshot.counts.conflictingKeys) {
        errorCode = result.errorCode || "PREFLIGHT_PROVIDER_EVIDENCE_HELD"; break;
      }
    }
    if (snapshots.length === 2 && !errorCode) {
      const day = modules.model.dayFromIso(iso(clock)), service = modules.service.createSearchDemandService({ store, readRegisteredKeywords: async () => [plan.keyword], clock });
      const hook = await service.onSnapshotCommitted(snapshots[1]);
      analysis = await service.analyze({ keyword: plan.keyword, day, month: day.slice(0, 7), page: 1, pageSize: 200 });
      forecast = analysis.forecast;
      const catalog = await store.listSnapshots({ keyword: plan.keyword, limit: 10 });
      need(catalog.total === 2 && catalog.truncated === false && duplicateChecks.length === 2, "PREFLIGHT_DUPLICATE_CHECK_FAILED");
      need(analysis.searchVolume.snapshotId === snapshots[0].snapshotId && analysis.trend.snapshotId === snapshots[1].snapshotId
        && analysis.related.total === snapshots[0].observations.length && analysis.related.counts.returnedRows === snapshots[0].counts.returnedRows
        && analysis.trend.coverage.expectedMonths === 12 && analysis.trend.coverage.observedMonths === 12, "PREFLIGHT_ANALYSIS_BINDING_FAILED");
      if (!["complete", "reused"].includes(hook.status) || forecast?.status !== "verified" || forecast?.published !== true) errorCode = hook.reasonCode || "PREFLIGHT_FORECAST_HELD";
    }
  } catch (error) { errorCode = /^PREFLIGHT_/.test(error.code || "") ? code(error.code) : "PREFLIGHT_VERIFICATION_FAILED"; }
  finally { for (const field of Object.keys(keys)) keys[field] = ""; }
  const finishedAt = iso(clock);
  if (modules.model.dayFromIso(startedAt) !== modules.model.dayFromIso(finishedAt)) errorCode = "PREFLIGHT_KST_DAY_CHANGED";
  const verified = counts.searchad === 1 && counts.datalab === 1 && snapshots.length === 2 && !errorCode;
  const summary = { schemaVersion: 1, status: verified ? "verified" : "needs_verification", completionVerified: verified, planSha256, keyword: plan.keyword,
    startedAt, finishedAt, requestCounts: counts, automaticRetries: false, connectionProvider: "ncp_apihub", results, errorCode,
    snapshotIds: snapshots.map(snapshot => snapshot.snapshotId), duplicateChecks, sourcePins: plan.files, credentialValuesExposed: false,
    collectionScheduleChanged: false, protectionReleased: false, kosisRead: false, applicationStarted: false,
    searchad: snapshots[0]?.provider === "searchad" ? { counts: snapshots[0].counts, anchor: modules.model.publicRow(snapshots[0].anchor) } : null,
    trend: snapshots.find(snapshot => snapshot.provider === "datalab") ? { counts: snapshots[1].counts, coverage: snapshots[1].coverage,
      startDate: snapshots[1].startDate, endDate: snapshots[1].endDate, windowId: snapshots[1].windowId } : null,
    forecast: forecast ? { status: forecast.status, reasonCode: forecast.reasonCode, forecastId: forecast.forecastId || null, value: forecast.value,
      inputVolume: forecast.inputVolume, factor: forecast.factor, changeRate: forecast.changeRate, basePeriod: forecast.basePeriod, seasonalPeriod: forecast.seasonalPeriod,
      method: forecast.method, sourceSnapshotIds: forecast.sourceSnapshotIds, trendWindowId: forecast.trendWindowId, published: forecast.published } : null };
  const evidence = jsonBytes({ summary, normalized: snapshots.map(snapshot => publicSnapshot(snapshot, modules.model)), analysis });
  need(evidence.length <= MAX.evidence, "PREFLIGHT_EVIDENCE_BOUNDS");
  const artifact = await immutable(evidenceFile, zlib.gzipSync(evidence), MAX.gzip);
  const receipt = { ...summary, artifact };
  await immutable(receiptFile, jsonBytes(receipt), MAX.receipt); return { ...receipt, reusedExistingEvidence: false, newRequestCounts: counts };
}

function parseArguments(values) {
  const output = { executeLive: false };
  for (let index = 0; index < values.length; index++) {
    const argument = values[index];
    if (argument === "--execute-live" && !output.executeLive) output.executeLive = true;
    else if (argument === "--plan" && !output.planFile) output.planFile = values[++index];
    else if (argument === "--plan-sha256" && !output.planSha256) output.planSha256 = values[++index];
    else throw failure("PREFLIGHT_ARGUMENT_INVALID");
  }
  return output;
}
if (require.main === module) {
  Promise.resolve().then(() => executePreflight({ ...parseArguments(process.argv.slice(2)), credentialEnvironment: process.env })).then(result => { process.stdout.write(JSON.stringify(result) + "\n"); })
    .catch(error => { process.stdout.write(JSON.stringify({ status: "needs_verification", errorCode: code(error.code), credentialValuesExposed: false }) + "\n"); process.exitCode = 1; });
}
module.exports = { buildPreflightPlan, executePreflight, parseArguments, FILES, MAX };
