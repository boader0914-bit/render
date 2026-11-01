"use strict";

// A bounded, explicitly approved data promotion. No provider, credentials,
// environment, application, collection scheduler, original rows or KOSIS import.
const fs = require("node:fs/promises"), { constants } = require("node:fs");
const path = require("node:path"), crypto = require("node:crypto"), vm = require("node:vm");
const APPROVED_OPS = "/var/data/operations/search-demand-release-20261101-v1";
const PRODUCTION_ROOT = "/var/data/search_demand", SOURCE_ROOT = "/opt/render/project/src";
const APPROVED_PLAN_SHA = "0da13f2c8027dd3d5589de411308dac275e57a8b1241a9a77d0e7c18b5895400";
const EXPECTED_IDS = Object.freeze(["sd_0d645f09c43edd576ef1be75ce514b644ce4a22f0689f11b1df14b1686e96f84", "sd_423193fff27d425f9e544c77b391bcc36eb880aba5447eb90a5d7173ca459c09"]);
const FILES = Object.freeze(["naver_datalab_connection.cjs", "search_demand_model.cjs", "search_demand_providers.cjs", "search_demand_store.cjs", "search_demand_forecast.cjs", "search_demand_service.cjs"].map(name => "scripts/lib/" + name));
const BUILTINS = new Set(["node:crypto", "node:fs", "node:fs/promises", "node:path"]);
const MAX = Object.freeze({ plan: 32768, source: 524288, receipt: 65536, policy: 4096, lock: 4096 });
const KEYWORD = "경남글램핑", VERSION = "search-demand-schedule-v1", NOT_BEFORE = "2026-11-02", SHA = /^[a-f0-9]{64}$/, SNAPSHOT = /^sd_[a-f0-9]{64}$/;
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const canonical = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const failure = suffix => Object.assign(new Error("검색 수요 승격 근거를 확인해 주세요."), { code: "SEARCH_DEMAND_PROMOTION_" + suffix });
const need = (condition, suffix) => { if (!condition) throw failure(suffix); };
const safeCode = code => /^SEARCH_DEMAND_PROMOTION_[A-Z_]{1,80}$/.test(code || "") ? code : "SEARCH_DEMAND_PROMOTION_UNAVAILABLE";
const validIso = value => typeof value === "string" && /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const day = value => new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10);
const same = (a, b) => ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(key => a[key] === b[key]);

async function parents(file) {
  need(typeof file === "string" && path.isAbsolute(file), "PATH_UNSAFE");
  const directory = path.dirname(path.resolve(file)), parsed = path.parse(directory), records = []; let current = parsed.root;
  for (const part of ["", ...directory.slice(parsed.root.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const stat = await fs.lstat(current, { bigint: true }), real = await fs.realpath(current);
    need(stat.isDirectory() && !stat.isSymbolicLink() && canonical(real) === canonical(current), "PATH_UNSAFE");
    records.push({ file: current, stat, real });
  }
  return records;
}
async function parentsStable(records) {
  for (const record of records) {
    const stat = await fs.lstat(record.file, { bigint: true }), real = await fs.realpath(record.file);
    need(stat.isDirectory() && !stat.isSymbolicLink() && canonical(real) === canonical(record.file), "PATH_UNSAFE");
    need(["dev", "ino", "mode"].every(key => stat[key] === record.stat[key]) && real === record.real, "EVIDENCE_CHANGED");
  }
}
async function readBytes(file, maximum, optional = false) {
  let handle, lineage = [];
  try {
    lineage = await parents(file); const before = await fs.lstat(file, { bigint: true });
    need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(maximum)
      && canonical(await fs.realpath(file)) === canonical(file), "FILE_UNSAFE");
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    need(same(before, await handle.stat({ bigint: true })), "EVIDENCE_CHANGED");
    const buffer = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < buffer.length) { const chunk = await handle.read(buffer, length, buffer.length - length, length); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
    need(BigInt(length) === before.size && same(before, await handle.stat({ bigint: true })) && same(before, await fs.lstat(file, { bigint: true })), "EVIDENCE_CHANGED");
    await parentsStable(lineage); return buffer.subarray(0, length);
  } catch (error) {
    if (optional && error.code === "ENOENT") { await parentsStable(lineage); return null; }
    throw error;
  } finally { await handle?.close(); }
}
function json(bytes) { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw failure("JSON_INVALID"); } }
async function writeNew(file, value, maximum) {
  const bytes = Buffer.from(JSON.stringify(value) + "\n"); need(bytes.length <= maximum, "WRITE_BOUNDS");
  const lineage = await parents(file); let handle;
  try { handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600); await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle?.close(); }
  await parentsStable(lineage); need((await readBytes(file, maximum)).equals(bytes), "WRITE_READBACK_FAILED");
  return bytes;
}
function validatePlan(plan, operationRoot) {
  need(plain(plan) && plan.schemaVersion === 1 && plan.purpose === "gyeongnam-search-demand-release-preflight" && plan.keyword === KEYWORD
    && canonical(plan.operationRoot) === canonical(operationRoot) && canonical(plan.codeRoot) === canonical(path.join(operationRoot, "code"))
    && plan.connectionProvider === "ncp_apihub" && plan.expectedRequests?.searchad === 1 && plan.expectedRequests?.datalab === 1
    && plan.requestWindow?.startDate === "2025-11-01" && plan.requestWindow?.endDate === "2026-10-31" && plan.requestWindow?.timeUnit === "month" && plan.requestWindow?.expectedMonths === 12
    && Array.isArray(plan.files) && plan.files.length === FILES.length && new Set(plan.files.map(row => row.path)).size === FILES.length
    && plan.files.every(row => FILES.includes(row.path) && Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= MAX.source && SHA.test(row.sha256)), "PLAN_INVALID");
}
async function pinnedModules(plan, sourceRoot) {
  const text = new Map(), loaded = new Map(), evidence = [];
  for (const pin of plan.files) {
    for (const root of [plan.codeRoot, sourceRoot]) {
      const file = path.join(root, pin.path), bytes = await readBytes(file, MAX.source);
      need(bytes.length === pin.bytes && digest(bytes) === pin.sha256, "SOURCE_SHA_MISMATCH"); evidence.push({ file, sha256: pin.sha256 });
      if (root === plan.codeRoot) text.set(pin.path, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    }
  }
  for (const [file, source] of text) {
    need(!/\brequire\s*\(\s*[^'"\s]/.test(source) && !/\bimport\s*\(/.test(source), "DEPENDENCY_UNSAFE");
    for (const match of source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      const target = match[1].startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])) : match[1];
      need(BUILTINS.has(target) || FILES.includes(target), "DEPENDENCY_UNSAFE");
    }
  }
  function load(file) {
    if (loaded.has(file)) return loaded.get(file).exports;
    need(text.has(file) && file !== "scripts/lib/search_demand_providers.cjs", "DEPENDENCY_UNSAFE");
    const module_ = { exports: {} }; loaded.set(file, module_);
    const require_ = name => BUILTINS.has(name) ? require(name) : load(path.posix.normalize(path.posix.join(path.posix.dirname(file), name)));
    new vm.Script("(function(exports,require,module,__filename,__dirname){\n" + text.get(file) + "\n})", { filename: file }).runInThisContext()
      (module_.exports, require_, module_, path.join(plan.codeRoot, file), path.dirname(path.join(plan.codeRoot, file)));
    return module_.exports;
  }
  return { model: load("scripts/lib/search_demand_model.cjs"), store: load("scripts/lib/search_demand_store.cjs"),
    service: load("scripts/lib/search_demand_service.cjs"), forecast: load("scripts/lib/search_demand_forecast.cjs"), evidence };
}
function policyMatches(policy, observedAt) {
  need(plain(policy) && Object.keys(policy).length === 4 && ["enabled", "approvedAt", "notBeforeDay", "scheduleVersion"].every(key => Object.hasOwn(policy, key))
    && policy.enabled === true && policy.notBeforeDay === NOT_BEFORE && policy.scheduleVersion === VERSION && validIso(policy.approvedAt)
    && Date.parse(policy.approvedAt) <= Date.parse(observedAt) && day(policy.approvedAt) <= NOT_BEFORE, "POLICY_CONFLICT");
  return policy;
}
function validateReceipt(receipt, plan, planSha256, expectedIds, observedAt) {
  need(plain(receipt) && receipt.schemaVersion === 1 && receipt.status === "verified" && receipt.completionVerified === true && receipt.planSha256 === planSha256
    && receipt.keyword === KEYWORD && receipt.connectionProvider === "ncp_apihub" && receipt.errorCode === null && receipt.automaticRetries === false
    && receipt.requestCounts?.searchad === 1 && receipt.requestCounts?.datalab === 1 && receipt.credentialValuesExposed === false
    && receipt.collectionScheduleChanged === false && receipt.protectionReleased === false && receipt.kosisRead === false && receipt.applicationStarted === false
    && validIso(receipt.startedAt) && validIso(receipt.finishedAt) && Date.parse(receipt.startedAt) <= Date.parse(receipt.finishedAt) && Date.parse(receipt.finishedAt) <= Date.parse(observedAt)
    && day(receipt.startedAt) === day(observedAt) && day(receipt.finishedAt) === day(observedAt)
    && Array.isArray(receipt.snapshotIds) && JSON.stringify(receipt.snapshotIds) === JSON.stringify(expectedIds)
    && JSON.stringify(receipt.sourcePins) === JSON.stringify(plan.files), "RECEIPT_UNVERIFIED");
  need(Array.isArray(receipt.results) && receipt.results.length === 2 && new Set(receipt.results.map(row => row.provider)).size === 2
    && ["searchad", "datalab"].every((provider, index) => receipt.results.some(row => row.provider === provider && row.status === "complete" && row.errorCode === null
      && row.requestCount === 1 && row.networkAttempted === true && row.snapshotId === expectedIds[index] && validIso(row.requestedAt) && validIso(row.observedAt)
      && Date.parse(row.requestedAt) <= Date.parse(row.observedAt) && Date.parse(row.observedAt) <= Date.parse(receipt.finishedAt))), "RECEIPT_UNVERIFIED");
  need(Array.isArray(receipt.duplicateChecks) && receipt.duplicateChecks.length === 2
    && ["searchad", "datalab"].every((provider, index) => receipt.duplicateChecks.some(row => row.provider === provider && row.snapshotId === expectedIds[index] && row.reused === true && row.createdOnDuplicate === false))
    && receipt.forecast?.status === "verified" && receipt.forecast.published === true && JSON.stringify(receipt.forecast.sourceSnapshotIds) === JSON.stringify(expectedIds), "RECEIPT_UNVERIFIED");
}

async function executePromotion({ planFile, planSha256, executeApproved = false, clock = Date.now } = {}, fixture = {}) {
  const testing = fixture.fixtureOnly === true, operationRoot = testing ? fixture.operationRoot : APPROVED_OPS,
    productionRoot = testing ? fixture.productionRoot : PRODUCTION_ROOT, sourceRoot = testing ? fixture.sourceRoot : SOURCE_ROOT,
    approvedSha = testing ? fixture.planSha256 : APPROVED_PLAN_SHA, expectedIds = testing ? fixture.expectedSnapshotIds : EXPECTED_IDS;
  need(typeof executeApproved === "boolean" && typeof clock === "function" && [planFile, operationRoot, productionRoot, sourceRoot].every(value => typeof value === "string" && path.isAbsolute(value))
    && canonical(planFile) === canonical(path.join(operationRoot, "plan.json")) && SHA.test(planSha256 || "") && planSha256 === approvedSha
    && Array.isArray(expectedIds) && expectedIds.length === 2 && new Set(expectedIds).size === 2 && expectedIds.every(value => SNAPSHOT.test(value)), "ARGUMENT_INVALID");
  need(testing || process.platform === "linux" && process.cwd() === SOURCE_ROOT, "WRONG_CENTRAL_SHELL");
  const timestamp = () => { const date = new Date(clock()); need(Number.isFinite(date.getTime()), "CLOCK_INVALID"); return date.toISOString(); }, observedAt = timestamp();
  need(day(observedAt) >= NOT_BEFORE, "NOT_BEFORE_DAY");
  const planBytes = await readBytes(planFile, MAX.plan); need(digest(planBytes) === planSha256, "PLAN_SHA_MISMATCH");
  const plan = json(planBytes); validatePlan(plan, operationRoot);
  const modules = await pinnedModules(plan, sourceRoot), receiptFile = path.join(operationRoot, "execution-result.json"), receiptBytes = await readBytes(receiptFile, MAX.receipt), receipt = json(receiptBytes);
  validateReceipt(receipt, plan, planSha256, expectedIds, observedAt);
  const sourceStore = modules.store.createSearchDemandStore({ rootDir: path.join(operationRoot, "validation-store"), clock }),
    productionStore = modules.store.createSearchDemandStore({ rootDir: productionRoot, clock }), policyFile = path.join(productionRoot, "activation.json"),
    service = modules.service.createSearchDemandService({ store: productionStore, readRegisteredKeywords: async () => [KEYWORD], clock });
  const snapshots = [];
  for (const [index, provider] of ["searchad", "datalab"].entries()) {
    const snapshot = await sourceStore.readSnapshot({ snapshotId: expectedIds[index] }); need(snapshot, "SNAPSHOT_MISSING"); modules.model.validateSnapshot(snapshot);
    const response = receipt.results.find(row => row.provider === provider);
    need(snapshot.provider === provider && snapshot.keyword === KEYWORD && snapshot.status === "ready" && snapshot.counts.reconciled === true
      && snapshot.counts.invalidRows === 0 && snapshot.counts.conflictingKeys === 0 && snapshot.day === day(observedAt) && snapshot.observedAt === response.observedAt
      && Date.parse(snapshot.observedAt) <= Date.parse(observedAt), "SNAPSHOT_UNVERIFIED");
    if (provider === "searchad") need(snapshot.anchor?.isAnchor === true && snapshot.anchor.total.state === "number", "ANCHOR_UNVERIFIED");
    else need(snapshot.connectionProvider === "ncp_apihub" && snapshot.startDate === plan.requestWindow.startDate && snapshot.endDate === plan.requestWindow.endDate
      && snapshot.timeUnit === "month" && snapshot.coverage.expectedMonths === 12 && snapshot.coverage.observedMonths === 12
      && Array.isArray(snapshot.coverage.missingMonths) && snapshot.coverage.missingMonths.length === 0, "TREND_UNVERIFIED");
    snapshots.push(snapshot);
  }
  const verifyEvidence = async () => {
    need(day(timestamp()) === day(observedAt), "DAY_CHANGED");
    need((await readBytes(planFile, MAX.plan)).equals(planBytes) && (await readBytes(receiptFile, MAX.receipt)).equals(receiptBytes), "EVIDENCE_CHANGED");
    for (const pin of modules.evidence) need(digest(await readBytes(pin.file, MAX.source)) === pin.sha256, "SOURCE_SHA_MISMATCH");
  };
  const policyRead = async () => { const bytes = await readBytes(policyFile, MAX.policy, true); return bytes ? policyMatches(json(bytes), timestamp()) : null; };
  let policy = await policyRead();
  if (!executeApproved) return { schemaVersion: 1, status: "ready_for_explicit_promotion", planSha256, sourcePinsVerified: true, snapshotsVerified: 2,
    policyPresent: Boolean(policy), operatingWrites: false, providerCalls: 0, apiCalls: 0, kosisRead: false };
  const lockFile = path.join(operationRoot, "promotion.lock.json"), owner = crypto.randomUUID(), lock = { schemaVersion: 1, owner, planSha256, startedAt: observedAt };
  try { await writeNew(lockFile, lock, MAX.lock); } catch (error) { if (error.code === "EEXIST") throw failure("EXISTING_LOCK_REVIEW_REQUIRED"); throw error; }
  let activationCreated = false, forecastCreated = false; const saved = [];
  try {
    policy = await policyRead();
    if (policy) {
      for (const snapshot of snapshots) need(await productionStore.readSnapshot({ snapshotId: snapshot.snapshotId }), "ACTIVE_DATA_MISSING");
    } else {
      for (const snapshot of snapshots) {
        const first = await productionStore.saveSnapshot(snapshot), second = await productionStore.saveSnapshot(snapshot), readback = await productionStore.readSnapshot({ snapshotId: snapshot.snapshotId });
        need(first.snapshotId === snapshot.snapshotId && second.snapshotId === snapshot.snapshotId && second.reused === true && second.created === false && readback?.snapshotId === snapshot.snapshotId, "DUPLICATE_CHECK_FAILED");
        saved.push({ provider: snapshot.provider, snapshotId: snapshot.snapshotId, created: first.created === true, duplicateReused: true });
      }
    }
    for (const snapshot of snapshots) {
      const latest = await productionStore.readLatest({ provider: snapshot.provider, keyword: KEYWORD, asOfDay: day(observedAt) });
      need(latest?.snapshotId === snapshot.snapshotId, "NEWER_INPUT_REQUIRES_REVIEW");
    }
    if (!policy) {
      const hook = await service.onSnapshotCommitted(snapshots[1]); need(["complete", "reused"].includes(hook.status), "FORECAST_HELD"); forecastCreated = hook.status === "complete";
    }
    const forecastHistory = await productionStore.listForecasts({ keyword: KEYWORD, month: day(observedAt).slice(0, 7), limit: 1000 }),
      forecasts = forecastHistory.rows.filter(row => row.status === "verified" && JSON.stringify(row.sourceSnapshotIds) === JSON.stringify(expectedIds));
    need(forecasts.length === 1 && forecastHistory.truncated === false, "FORECAST_BINDING_UNVERIFIED"); const forecast = forecasts[0];
    need(forecast.trendWindowId === snapshots[1].windowId && forecast.inputVolume === snapshots[0].anchor.total.value
      && forecast.searchObservedAt === snapshots[0].observedAt && forecast.trendObservedAt === snapshots[1].observedAt, "FORECAST_BINDING_UNVERIFIED");
    const reproduced = modules.forecast.buildSearchDemandForecast({ keyword: KEYWORD, searchSnapshot: snapshots[0], trendSnapshot: snapshots[1],
      targetMonth: forecast.targetMonth, calculatedAt: forecast.calculatedAt });
    need(reproduced.status === "verified" && Object.keys(reproduced).every(key => JSON.stringify(reproduced[key]) === JSON.stringify(forecast[key])), "FORECAST_REPRODUCTION_FAILED");
    await verifyEvidence();
    if (!policy) {
      const value = { enabled: true, approvedAt: timestamp(), notBeforeDay: NOT_BEFORE, scheduleVersion: VERSION };
      need(day(value.approvedAt) <= NOT_BEFORE, "ACTIVATION_DAY_REQUIRES_REVIEW");
      try { await writeNew(policyFile, value, MAX.policy); activationCreated = true; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      policy = await policyRead(); need(policy, "POLICY_READBACK_FAILED");
    }
    need(day(timestamp()) === day(observedAt), "DAY_CHANGED");
    const snapshotResults = snapshots.map(snapshot => ({ provider: snapshot.provider, snapshotId: snapshot.snapshotId, observedAt: snapshot.observedAt,
      status: snapshot.status, returnedRows: snapshot.counts.returnedRows, uniqueRows: snapshot.counts.uniqueRows,
      created: saved.find(row => row.snapshotId === snapshot.snapshotId)?.created || false, duplicateReused: true }));
    return { schemaVersion: 1, status: "verified", completionVerified: true, keyword: KEYWORD, planSha256, observedAt: timestamp(), day: day(observedAt),
      reusedExistingPromotion: !activationCreated && !forecastCreated && !snapshotResults.some(row => row.created), snapshots: snapshotResults,
      forecast: { forecastId: forecast.forecastId, targetMonth: forecast.targetMonth, value: forecast.value, inputVolume: forecast.inputVolume, factor: forecast.factor,
        basePeriod: forecast.basePeriod, seasonalPeriod: forecast.seasonalPeriod, method: forecast.method, sourceSnapshotIds: forecast.sourceSnapshotIds },
      activation: policy, writes: { snapshotsCreated: snapshotResults.filter(row => row.created).length, forecastCreated, activationCreated },
      providerCalls: 0, apiCalls: 0, newRequestCounts: { searchad: 0, datalab: 0 }, credentialsRead: false, environmentRead: false,
      applicationStarted: false, collectionScheduleChanged: false, protectionReleased: false, originalRowsRead: false, kosisRead: false };
  } finally {
    try { const current = json(await readBytes(lockFile, MAX.lock)); if (current.owner === owner && current.planSha256 === planSha256) await fs.unlink(lockFile); } catch {}
  }
}
function parseArguments(values) {
  const result = { executeApproved: false };
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === "--execute-approved" && !result.executeApproved) result.executeApproved = true;
    else if (value === "--plan" && !result.planFile) result.planFile = values[++index];
    else if (value === "--plan-sha256" && !result.planSha256) result.planSha256 = values[++index];
    else throw failure("ARGUMENT_INVALID");
  }
  return result;
}
if (require.main === module) Promise.resolve().then(() => executePromotion(parseArguments(process.argv.slice(2)))).then(result => process.stdout.write(JSON.stringify(result) + "\n"))
  .catch(error => { process.stdout.write(JSON.stringify({ status: "needs_verification", completionVerified: false, errorCode: safeCode(error.code), providerCalls: 0, apiCalls: 0, credentialsRead: false, kosisRead: false }) + "\n"); process.exitCode = 1; });
module.exports = { executePromotion, parseArguments, FILES, MAX };
