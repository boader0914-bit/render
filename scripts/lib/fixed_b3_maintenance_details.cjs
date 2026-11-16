"use strict";
// Diagnostic capability only: no lease acquisition/release, retirement, mkdir,
// app import, API, network, login, cmdline, environment, cwd or exe inspection.
const fs = require("node:fs/promises"), C = require("node:fs").constants, path = require("node:path"), crypto = require("node:crypto");
const OP = "ea380222-d4db-46f4-a924-bc20bee7bdc6", RELEASE = "identity-auto-release-20261116-0e7fbd45-dbee-446c-817a-caebdd01b3ae";
const REQUEST_SHA = "81e38b057e5c164c9b3efad42d9eb722009c2cd50451b1bec1160d358ee48f54", RUNNER_SHA = "9cc93912ed9402b3d46fe1af573a5aa33d9e3cb7bd8dcee74a2de87d2f55d43e";
const SHA = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, FIELDS = ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink", "mode", "uid", "gid"];
const LIMITS = Object.freeze({ marker: 16384, request: 65536, runner: 1024 ** 2, jobInput: 1024 ** 2, proof: 65536, receipt: 128 * 1024, pseudo: 8192, milliseconds: 10000 });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validPid = value => Number.isSafeInteger(value) && value > 0;
const iso = value => typeof value === "string" && /^20\d{2}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); }, same = (a, b) => FIELDS.every(key => a[key] === b[key]);
function smallStat(value) { return Object.fromEntries(FIELDS.map(key => [key, String(value[key])])); }
async function checked(file, directory = false) {
  const absolute = path.resolve(file), root = path.parse(absolute).root; let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); const stat = await fs.lstat(current, { bigint: true });
    need(!stat.isSymbolicLink() && path.resolve(await fs.realpath(current)) === current && (current === absolute || stat.isDirectory()), "B3_INSPECT_UNSAFE_PATH"); }
  const stat = await fs.lstat(absolute, { bigint: true }); need(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n, "B3_INSPECT_UNSAFE_PATH"); return stat;
}
async function readMaybe(file, maximum, parseJson = true, metadataOnOversize = false) {
  let before; try { before = await checked(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (metadataOnOversize && before.size > BigInt(maximum)) return { file, stat: before, sha256: null, bytes: Number(before.size), value: null, jsonValid: false, tooLarge: true, contentRead: false };
  need(before.size > 0n && before.size <= BigInt(maximum), "B3_INSPECT_FILE_BOUND");
  const handle = await fs.open(file, C.O_RDONLY | (C.O_NOFOLLOW || 0)); let bytes;
  try { need(same(before, await handle.stat({ bigint: true })), "B3_INSPECT_FILE_CHANGED"); const buffer = Buffer.alloc(Number(before.size) + 1); let at = 0;
    while (at < buffer.length) { const item = await handle.read(buffer, at, buffer.length - at, at); if (!item.bytesRead) break; at += item.bytesRead; }
    need(BigInt(at) === before.size && same(before, await handle.stat({ bigint: true })) && same(before, await checked(file)), "B3_INSPECT_FILE_CHANGED"); bytes = buffer.subarray(0, at);
  } finally { await handle.close(); }
  let value = null, jsonValid = false;
  if (parseJson) { try { value = JSON.parse(bytes.toString("utf8")); jsonValid = object(value); } catch {} }
  return { file, stat: before, sha256: hash(bytes), bytes: bytes.length, value, jsonValid };
}
function schemaValid(value) { return exact(value, ["schemaVersion", "kind", "token", "pid", "createdAt", "operationId", "mode", "contextSha256"])
  && value.schemaVersion === 1 && value.kind === "keyword_prepared_conversion_maintenance" && UUID.test(value.token || "") && validPid(value.pid)
  && iso(value.createdAt) && UUID.test(value.operationId || "") && ["stage", "publish"].includes(value.mode) && SHA.test(value.contextSha256 || ""); }
async function pseudo(file, maximum) {
  const handle = await fs.open(file, C.O_RDONLY | (C.O_NOFOLLOW || 0));
  try { const buffer = Buffer.alloc(maximum + 1); let at = 0; while (at < buffer.length) { const row = await handle.read(buffer, at, buffer.length - at, at); if (!row.bytesRead) break; at += row.bytesRead; }
    need(at <= maximum, "B3_INSPECT_PROCESS_BOUND"); return buffer.subarray(0, at).toString("utf8"); }
  finally { await handle.close(); }
}
function statIdentity(raw, pid) {
  const end = raw.lastIndexOf(")"), prefix = raw.slice(0, raw.indexOf("(")).trim(), fields = raw.slice(end + 2).trim().split(/\s+/);
  need(prefix === String(pid) && end > 1 && fields.length >= 20 && /^\d+$/.test(fields[19]) && /^\d+$/.test(fields[1]), "B3_INSPECT_PROCESS_UNKNOWN");
  return { startTicks: fields[19], parentPid: Number(fields[1]), statComm: raw.slice(raw.indexOf("(") + 1, end) };
}
async function processMetadata(pid, procRoot) {
  try {
    const directory = path.join(procRoot, String(pid)), a = statIdentity(await pseudo(path.join(directory, "stat"), LIMITS.pseudo), pid), comm = (await pseudo(path.join(directory, "comm"), 256)).replace(/\n$/, ""),
      b = statIdentity(await pseudo(path.join(directory, "stat"), LIMITS.pseudo), pid), afterComm = (await pseudo(path.join(directory, "comm"), 256)).replace(/\n$/, "");
    need(a.startTicks === b.startTicks && a.parentPid === b.parentPid && a.statComm === b.statComm && a.statComm === comm && comm === afterComm, "B3_INSPECT_PROCESS_CHANGED");
    return { state: "present_current_namespace_only", pid, parentPid: b.parentPid, startTicks: b.startTicks,
      knownKind: /^(?:node|nodejs)$/.test(comm) ? "node" : /^(?:python|python3|python3[.]11)$/.test(comm) ? "python" : /^(?:sh|bash|dash)$/.test(comm) ? "shell" : "other", commSha256: hash(comm), ownerIdentityProven: false };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return { state: "absent_current_namespace_only", pid, ownerIdentityProven: false };
    if (["EACCES", "EPERM"].includes(error.code)) return { state: "unavailable_privacy_or_permission_hold", pid, ownerIdentityProven: false };
    throw error;
  }
}
const statuses = new Set(["complete", "staged", "published", "failed", "needs_verification", "prepared", "available", "held", "waiting"]);
function smallFile(read) { return read ? { present: true, sha256: read.sha256, bytes: read.bytes, jsonValid: read.jsonValid, contentRead: read.contentRead !== false, tooLarge: read.tooLarge === true,
  ...(statuses.has(read.value?.status || read.value?.state) ? { status: read.value.status || read.value.state } : {}),
  ...(validPid(read.value?.pid) ? { pid: read.value.pid } : {}), ...(validPid(read.value?.childPid) ? { childPid: read.value.childPid } : {}) } : { present: false }; }
async function inspectB3Maintenance({ dataDir, codeRoot } = {}, dependencies = {}) {
  need(typeof dataDir === "string" && path.isAbsolute(dataDir) && typeof codeRoot === "string" && path.isAbsolute(codeRoot), "B3_INSPECT_ARGUMENT_INVALID"); dataDir = path.resolve(dataDir); codeRoot = path.resolve(codeRoot);
  const fixture = dependencies.fixture === true, requestSha = fixture ? dependencies.requestSha256 : REQUEST_SHA, runnerSha = fixture ? dependencies.runnerSha256 : RUNNER_SHA;
  need(SHA.test(requestSha || "") && SHA.test(runnerSha || ""), "B3_INSPECT_FROZEN_PIN_INVALID");
  const started = Date.now(), checkpoint = () => need(Date.now() - started <= LIMITS.milliseconds, "B3_INSPECT_TIME_BOUND"), holds = [], reads = [], missing = [];
  const releaseDir = path.join(dataDir, "operations", RELEASE), operationDir = path.join(dataDir, "operations", "keyword-identity-prepared-20261116", OP), jobRoot = path.join(dataDir, "keyword_monthly_incremental", "jobs", "refresh-job-" + OP);
  const files = { marker: [path.join(dataDir, "keyword_monthly_incremental/prepared-conversion-lock.json"), LIMITS.marker],
    frozenRequest: [path.join(releaseDir, "b3-request-stage.json"), LIMITS.request], runner: [path.join(releaseDir, "rebuild-reviewed-monthly-publish-v4.cjs"), LIMITS.runner, false],
    storedRequest: [path.join(operationDir, "request.json"), LIMITS.request], requestBinding: [path.join(operationDir, "request-binding.json"), LIMITS.request],
    stageComplete: [path.join(operationDir, "stage-complete.json"), LIMITS.receipt, true, true], stageFailed: [path.join(operationDir, "stage-failed.json"), LIMITS.request],
    publishIntent: [path.join(operationDir, "publish-intent.json"), LIMITS.receipt, true, true], publishComplete: [path.join(operationDir, "publish-complete.json"), LIMITS.receipt, true, true],
    refreshOwner: [path.join(jobRoot, "refresh-owner.json"), LIMITS.request], jobInput: [path.join(jobRoot, "job-input.json"), LIMITS.jobInput],
    isolation: [path.join(jobRoot, "control/isolation.json"), LIMITS.proof], preparationComplete: [path.join(jobRoot, "preparation-complete.json"), LIMITS.receipt, true, true], preparationFailed: [path.join(jobRoot, "preparation-failed.json"), LIMITS.proof],
    publicCurrent: [path.join(dataDir, "keyword_monthly_analysis/current.json"), LIMITS.marker], sourceCurrent: [path.join(dataDir, "keyword_monthly_incremental/source-current.json"), LIMITS.marker] };
  const saved = {};
  const readKnown = async key => { const [file, maximum, parseJson, metadataOnOversize] = files[key]; checkpoint(); saved[key] = await readMaybe(file, maximum, parseJson !== false, metadataOnOversize === true); if (saved[key]) reads.push(saved[key]); else missing.push(file); };
  for (const key of ["marker", "frozenRequest", "runner", "publicCurrent", "sourceCurrent"]) await readKnown(key);
  const existsDir = async directory => { try { await checked(directory, true); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
  const marker = saved.marker?.value, markerSchemaValidity = schemaValid(marker), request = saved.frozenRequest?.value;
  const fixedRequestShaMatch = saved.frozenRequest?.sha256 === requestSha, fixedRunnerShaMatch = saved.runner?.sha256 === runnerSha;
  if (!fixedRequestShaMatch) holds.push("FROZEN_REQUEST_UNAVAILABLE_OR_DIFFERENT"); if (!fixedRunnerShaMatch) holds.push("FROZEN_RUNNER_UNAVAILABLE_OR_DIFFERENT");
  if (saved.marker && !markerSchemaValidity) holds.push("MARKER_SCHEMA_UNVERIFIED");
  const ownershipPolicySatisfied = !saved.marker ? null : fixture && dependencies.ownershipPolicySatisfied === true ? true : process.platform === "win32" ? null
    : typeof process.getuid === "function" && saved.marker.stat.uid === BigInt(process.getuid()) && (saved.marker.stat.mode & 0o777n) === 0o600n;
  if (saved.marker && ownershipPolicySatisfied !== true) holds.push("MARKER_OWNERSHIP_UNVERIFIED");
  const exactOpMatch = Boolean(markerSchemaValidity && marker.operationId === OP), fixedRequestOperation = Boolean(fixedRequestShaMatch && request?.operationId === OP && request.dataDir === dataDir && request.codeRoot === path.join(releaseDir, "code")),
    exactOperationAdmission = exactOpMatch && ownershipPolicySatisfied === true && fixedRequestOperation && fixedRunnerShaMatch;
  if (saved.marker && !exactOpMatch) holds.push("MARKER_NOT_EXACT_REVIEWED_OPERATION");
  if (fixedRequestShaMatch && !fixedRequestOperation) holds.push("FROZEN_REQUEST_OPERATION_UNVERIFIED");
  let operationDirectoryPresent = null, jobDirectoryPresent = null;
  if (exactOperationAdmission) {
    operationDirectoryPresent = await existsDir(operationDir); jobDirectoryPresent = await existsDir(jobRoot);
    for (const key of Object.keys(files).filter(key => !Object.hasOwn(saved, key))) await readKnown(key);
    if (reads.some(row => row.tooLarge)) holds.push("KNOWN_RECEIPT_TOO_LARGE_CONTENT_NOT_READ");
  }
  const contextReader = fixture && dependencies.contextReader ? dependencies.contextReader
    : require(path.join(codeRoot, "scripts/lib/keyword_monthly_worker_lock.cjs")).createLinuxProcessReader().context;
  let currentContextSha256 = null;
  try { currentContextSha256 = hash(JSON.stringify(await contextReader())); } catch { holds.push("CURRENT_CONTEXT_UNAVAILABLE"); }
  const contextDiffers = exactOperationAdmission && currentContextSha256 ? marker.contextSha256 !== currentContextSha256 : null;
  const input = saved.jobInput?.value, owner = saved.refreshOwner?.value, proof = saved.isolation?.value, complete = saved.preparationComplete?.value, stage = saved.stageComplete?.value;
  const sourceKey = input?.version && input?.evidence ? hash(JSON.stringify([input.version, input.evidence.runId, input.evidence.manifestSha256, input.evidence.keyword])) : null;
  const jobInputBound = Boolean(saved.jobInput?.jsonValid && input.schemaVersion === 1 && /^keyword-monthly-incremental-v\d+$/.test(input.version || "") && input.dataDir === dataDir
    && fixedRequestShaMatch && request?.operationId === OP && input.capturedAt === request.fixedClock && input.initialBundle?.pointerSha256 === request.expectedPointerSha256);
  const refreshOwnerBound = Boolean(jobInputBound && exact(owner, ["schemaVersion", "token", "sourceKey", "root"]) && owner.schemaVersion === 1 && owner.token === OP && owner.root === jobRoot && owner.sourceKey === sourceKey);
  const isolationBound = Boolean(refreshOwnerBound && proof?.mode === "seccomp" && validPid(proof.pid) && proof.expectedRoot === jobRoot && proof.noNewPrivs === true && proof.seccompMode === 2
    && proof.networkFdsClosed === true && proof.preflightOnly === false && proof.environmentSanitizedForExec === true && proof.unrestrictedFallbackAllowed === false && proof.providerCalls === 0
    && SHA.test(proof.guardSha256 || "") && SHA.test(proof.nodeSha256 || ""));
  const childPid = isolationBound ? proof.pid : null;
  const childCompleteBound = Boolean(isolationBound && complete?.status === "complete" && complete.version === input.version && complete.capturedAt === input.capturedAt
    && complete.isolation?.pid === childPid && complete.isolation?.proofSha256 === saved.isolation.sha256 && complete.providerCalls === 0 && complete.sourceWrites === 0
    && complete.appEntryExecutions === 0 && complete.kosisReadOrChanged === false);
  const failed = saved.preparationFailed?.value;
  const childFailureBound = Boolean(isolationBound && failed?.status === "needs_verification" && failed.jobId === OP && failed.pid === childPid && failed.sourceKey === sourceKey
    && failed.jobInputSha256 === saved.jobInput.sha256 && failed.ownerSha256 === saved.refreshOwner.sha256 && failed.proofSha256 === saved.isolation.sha256);
  let ownerProcess = !exactOperationAdmission ? "not_read_exact_operation_unverified" : contextDiffers === true ? "not_read_context_differs" : contextDiffers === null ? "not_read_context_unavailable" : null,
    childProcess = !exactOperationAdmission ? "not_read_exact_operation_unverified" : !isolationBound ? "not_read_no_bound_child_pid" : contextDiffers === true ? "not_read_context_differs" : contextDiffers === null ? "not_read_context_unavailable" : null;
  // A PID in another context may refer to an unrelated process here. Never
  // read its metadata, and never read cmdline/exe/cwd/environment in any case.
  const procRoot = fixture ? dependencies.procRoot : "/proc";
  if (ownerProcess === null) ownerProcess = await processMetadata(marker.pid, procRoot);
  if (childProcess === null) childProcess = await processMetadata(childPid, procRoot);
  if ([ownerProcess, childProcess].some(row => object(row) && row.state === "unavailable_privacy_or_permission_hold")) holds.push("PROCESS_METADATA_UNAVAILABLE");
  const publicAgain = await readMaybe(files.publicCurrent[0], LIMITS.marker), sourceAgain = await readMaybe(files.sourceCurrent[0], LIMITS.marker);
  need((publicAgain?.sha256 || null) === (saved.publicCurrent?.sha256 || null) && (sourceAgain?.sha256 || null) === (saved.sourceCurrent?.sha256 || null), "B3_INSPECT_POINTER_CHANGED");
  if (currentContextSha256) need(hash(JSON.stringify(await contextReader())) === currentContextSha256, "B3_INSPECT_CONTEXT_CHANGED");
  if (fixture && typeof dependencies.beforeFinalCheck === "function") await dependencies.beforeFinalCheck();
  for (const row of reads) need(same(row.stat, await checked(row.file)), "B3_INSPECT_FILE_CHANGED");
  for (const file of missing) { let present = false; try { await checked(file); present = true; } catch (error) { if (error.code !== "ENOENT") throw error; } need(!present, "B3_INSPECT_FILE_APPEARED"); }
  checkpoint();
  const result = { schemaVersion: 1, kind: "b3_maintenance_read_only_inspection", status: holds.length ? "held" : "inspected", operation: OP, fixture,
    exactOpMatch, exactOperationAdmission, marker: saved.marker ? { present: true, sha256: saved.marker.sha256, stat: smallStat(saved.marker.stat), schemaValidity: markerSchemaValidity,
      ownershipPolicySatisfied, ...(exactOperationAdmission ? { pid: marker.pid, mode: marker.mode, createdAt: marker.createdAt } : {}) } : { present: false, schemaValidity: false },
    currentContextSha256, contextDiffers, ownerProcess, childProcess, argumentMatching: "not_performed_privacy_hold", fixedRequestShaMatch, fixedRunnerShaMatch,
    operationDirectoryPresent, jobDirectoryPresent, files: Object.fromEntries(Object.keys(files).filter(key => key !== "marker").map(key => [key, Object.hasOwn(saved, key) ? smallFile(saved[key]) : { contentRead: false, notReadReason: "exact_operation_unverified" }])),
    bindings: { frozenRequestOperation: fixedRequestOperation,
      storedRequestMatchesFrozen: Boolean(saved.storedRequest?.jsonValid && fixedRequestShaMatch && hash(JSON.stringify(saved.storedRequest.value)) === hash(JSON.stringify(request))),
      requestBindingMatchesFrozenSha: saved.requestBinding?.value?.requestSha256 === requestSha, jobInputBound, refreshOwnerBound, isolationBound, childCompleteBound, childFailureBound,
      stageCompleteBound: Boolean(stage?.status === "staged" && stage.operationId === OP && stage.operatorRequestSha256 === requestSha && stage.jobRoot === jobRoot && stage.jobInputSha256 === saved.jobInput?.sha256
        && stage.childCompletionSha256 === saved.preparationComplete?.sha256 && stage.proofSha256 === saved.isolation?.sha256 && stage.childPid === childPid),
      publicationIntentPresent: Boolean(saved.publishIntent), publicationCompletePresent: Boolean(saved.publishComplete) },
    publicCurrentSha256: saved.publicCurrent?.sha256 || null, sourceCurrentSha256: saved.sourceCurrent?.sha256 || null, pointersReadTwiceStable: true, holdReasons: holds,
    retirementAuthorized: false, ownershipOrLivenessProven: false, sourceWrites: 0, operationalActions: 0, networkAttempted: false, cmdlineRead: false, environmentRead: false,
    interpretation: "Bounded observations of this exact operation only. Different contexts do not authorize PID inspection; absent current-namespace processes do not prove retirement. No marker or source state may be changed on this receipt alone." };
  return result;
}
function args(argv) { need(argv.length === 4 && argv[0] === "--data-dir" && argv[2] === "--code-root" && path.isAbsolute(argv[1] || "") && path.isAbsolute(argv[3] || ""), "B3_INSPECT_ARGUMENT_INVALID"); return { dataDir: argv[1], codeRoot: argv[3] }; }
module.exports = { inspectB3Maintenance, args, LIMITS, EXPECTED_B3: Object.freeze({ operation: OP, release: RELEASE, requestSha256: REQUEST_SHA, runnerSha256: RUNNER_SHA }) };
if (require.main === module) Promise.resolve().then(() => inspectB3Maintenance(args(process.argv.slice(2)))).then(result => process.stdout.write(JSON.stringify(result) + "\n"))
  .catch(error => { process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: "b3_maintenance_read_only_inspection", status: "held", operation: OP,
    code: /^B3_INSPECT_[A-Z0-9_]{1,100}$/.test(error?.code || "") ? error.code : "B3_INSPECT_UNAVAILABLE", retirementAuthorized: false,
    sourceWrites: 0, operationalActions: 0, networkAttempted: false, cmdlineRead: false, environmentRead: false }) + "\n"); process.exitCode = 2; });
