"use strict";
// Bounded diagnostics only. No exception message, source values, environment,
// stdout/stderr, or arbitrary object properties are persisted. A failed child
// cannot publish anything; this receipt only explains an already-closed child.
const fs = require("node:fs/promises"), path = require("node:path"), v8 = require("node:v8"), os = require("node:os");
const H = require("./keyword_monthly_refresh_preparation.cjs");
const KIND = "keyword_monthly_incremental_failure_v1", MAX_BYTES = 8192;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PHASES = new Set(["validated_input", "initial_bundle", "metadata_inventory", "seed_dependencies", "source_admission", "metadata_runs", "source_context", "scope_plan", "scope_normalize", "scope_projection", "scope_record", "diagnostic_validation", "prepared_results", "final_verification", "completion_receipt"]);
const SCOPE_PHASES = new Set(["normalize_before", "normalize_after", "projection_before", "projection_after"]);
const MEMORY_KEYS = ["heapUsed", "heapTotal", "rss", "external", "arrayBuffers", "heapSizeLimit"];
const safeCode = value => typeof value === "string" && /^(?:ISOLATION_|KEYWORD_)[A-Z0-9_]{1,150}$/.test(value) ? value : null;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const integer = n => Number.isSafeInteger(n) && n >= 0;
const fail = () => { throw H.fault("KEYWORD_INCREMENTAL_FAILURE_EVIDENCE_INVALID"); };
const need = value => { if (!value) fail(); };
const failureFile = jobRoot => path.join(jobRoot, "preparation-failed.json");
function termination(error) {
  const pid = Number.isSafeInteger(error?.pid) && error.pid > 0 ? error.pid : null;
  const exitCode = Number.isSafeInteger(error?.exitCode) && error.exitCode >= 0 && error.exitCode <= 65535 ? error.exitCode : null;
  const exitSignal = typeof error?.exitSignal === "string" && Object.hasOwn(os.constants.signals, error.exitSignal) ? error.exitSignal : null;
  return { childPid: pid, childExitCode: exitCode, childExitSignal: exitSignal };
}
async function captureBinding({ jobRoot, inputFile = path.join(jobRoot, "job-input.json"), inputSha256, sourceKey, version, pid, proofSha256 = null, guardSha256 = null, nodeSha256 = null }) {
  H.absolute(jobRoot); const directory = await H.checked(jobRoot, true);
  need(path.basename(inputFile) === "job-input.json" && path.dirname(inputFile) === jobRoot && H.SHA.test(inputSha256) && H.SHA.test(sourceKey) && typeof version === "string"
    && Number.isSafeInteger(pid) && pid > 0 && /^refresh-job-/.test(path.basename(jobRoot)));
  if (process.platform !== "win32") need((directory.mode & 0o777) === 0o700 && (typeof process.getuid !== "function" || directory.uid === process.getuid()));
  const jobId = path.basename(jobRoot).slice("refresh-job-".length); need(UUID.test(jobId));
  const owner = await H.read(path.join(jobRoot, "refresh-owner.json"), MAX_BYTES), input = await H.read(inputFile, 1024 * 1024);
  need(exact(owner.value, ["schemaVersion", "token", "sourceKey", "root"]) && owner.value.schemaVersion === 1 && owner.value.token === jobId && owner.value.sourceKey === sourceKey && owner.value.root === jobRoot
    && input.sha256 === inputSha256 && input.value.version === version && path.dirname(jobRoot) === path.join(H.absolute(input.value.dataDir), "keyword_monthly_incremental", "jobs"));
  const evidence = H.validateEvidence(input.value.evidence); need(H.hash(JSON.stringify([version, evidence.runId, evidence.manifestSha256, evidence.keyword])) === sourceKey);
  const proofFile = path.join(jobRoot, "control", "isolation.json"), proof = await H.read(proofFile, 65536), p = proof.value;
  need(p.mode === "seccomp" && p.pid === pid && p.expectedRoot === jobRoot && p.noNewPrivs === true && p.seccompMode === 2 && p.networkFdsClosed === true
    && p.preflightOnly === false && p.environmentSanitizedForExec === true && p.unrestrictedFallbackAllowed === false && p.providerCalls === 0
    && H.SHA.test(p.guardSha256) && H.SHA.test(p.nodeSha256) && (proofSha256 === null || proof.sha256 === proofSha256)
    && (guardSha256 === null || p.guardSha256 === guardSha256) && (nodeSha256 === null || p.nodeSha256 === nodeSha256));
  return Object.freeze({ jobRoot, inputFile, inputSha256, sourceKey, version, pid, jobId, ownerSha256: owner.sha256, proofSha256: proof.sha256, guardSha256: p.guardSha256, nodeSha256: p.nodeSha256 });
}
function frames(error, codeRoot) {
  const prefix = path.join(codeRoot, "scripts") + path.sep, rows = [];
  for (const line of String(error?.stack || "").split(/\r?\n/).slice(1, 16)) {
    const start = line.indexOf(prefix); if (start < 0) continue;
    const found = line.slice(start + prefix.length).match(/^([A-Za-z0-9_./\\-]{1,180}\.cjs):(\d{1,7}):(\d{1,7})(?:\)|$)/);
    if (found && !found[1].split(/[\\/]/).includes("..") && Number(found[2]) > 0 && Number(found[3]) > 0) rows.push({ file: found[1].replaceAll("\\", "/"), line: Number(found[2]), column: Number(found[3]) });
    if (rows.length === 6) break;
  } return rows;
}
function memoryCounters() { const usage = process.memoryUsage(); return Object.fromEntries(MEMORY_KEYS.map(k => [k, k === "heapSizeLimit" ? v8.getHeapStatistics().heap_size_limit : usage[k]])); }
async function assertBinding(binding) { const current = await captureBinding({ ...binding, proofSha256: binding.proofSha256 }); need(JSON.stringify(current) === JSON.stringify(binding)); }
async function writePhase({ binding, phase, scopeIndex, startedAt }) {
  need(binding.pid === process.pid && SCOPE_PHASES.has(phase) && integer(scopeIndex) && scopeIndex < 128); await assertBinding(binding);
  const value = { schemaVersion: 1, kind: "keyword_monthly_incremental_phase_v1", jobId: binding.jobId, sourceKey: binding.sourceKey, pid: binding.pid,
    jobInputSha256: binding.inputSha256, ownerSha256: binding.ownerSha256, proofSha256: binding.proofSha256, phase, scopeIndex,
    memory: memoryCounters(), elapsedMs: Math.max(0, Date.now() - startedAt), observedAt: new Date().toISOString(), diagnosticsOnly: true };
  need(Buffer.byteLength(JSON.stringify(value)) <= 4096 && Object.values(value.memory).every(integer));
  return H.writeNew(path.join(binding.jobRoot, "phase-" + String(scopeIndex).padStart(3, "0") + "-" + phase + ".json"), value);
}
function validate(value, binding) {
  need(exact(value, ["schemaVersion", "kind", "status", "version", "sourceKey", "jobId", "pid", "jobInputSha256", "ownerSha256", "proofSha256", "guardSha256", "nodeSha256", "code", "errorType", "frames", "memory", "progress", "elapsedMs", "observedAt", "diagnosticsOnly"])
    && value.schemaVersion === 1 && value.kind === KIND && value.status === "failed" && value.diagnosticsOnly === true && safeCode(value.code)
    && ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError"].includes(value.errorType) && H.validIso(value.observedAt) && integer(value.elapsedMs) && value.elapsedMs <= 7 * 86400000);
  for (const [key, expected] of Object.entries({ version: binding.version, sourceKey: binding.sourceKey, jobId: binding.jobId, pid: binding.pid, jobInputSha256: binding.inputSha256,
    ownerSha256: binding.ownerSha256, proofSha256: binding.proofSha256, guardSha256: binding.guardSha256, nodeSha256: binding.nodeSha256 })) need(value[key] === expected);
  need(exact(value.memory, MEMORY_KEYS) && MEMORY_KEYS.every(key => integer(value.memory[key])) && exact(value.progress, ["phase", "scopeIndex", "plannedScopes", "completedParts"])
    && PHASES.has(value.progress.phase) && ["scopeIndex", "plannedScopes"].every(k => value.progress[k] === null || integer(value.progress[k]) && value.progress[k] <= 4096)
    && integer(value.progress.completedParts) && value.progress.completedParts <= 4096 && Array.isArray(value.frames) && value.frames.length <= 6
    && value.frames.every(f => exact(f, ["file", "line", "column"]) && /^[A-Za-z0-9_./-]{1,180}\.cjs$/.test(f.file) && !f.file.split("/").includes("..") && integer(f.line) && f.line > 0 && f.line < 1e7 && integer(f.column) && f.column > 0 && f.column < 1e7));
  return value;
}
async function writeFailure({ binding, error, codeRoot, progress, startedAt }) {
  need(binding.pid === process.pid); H.absolute(codeRoot);
  await assertBinding(binding); const memory = memoryCounters();
  const value = validate({ schemaVersion: 1, kind: KIND, status: "failed", version: binding.version, sourceKey: binding.sourceKey, jobId: binding.jobId, pid: binding.pid,
    jobInputSha256: binding.inputSha256, ownerSha256: binding.ownerSha256, proofSha256: binding.proofSha256, guardSha256: binding.guardSha256, nodeSha256: binding.nodeSha256,
    code: safeCode(error?.code) || "KEYWORD_INCREMENTAL_RECONSTRUCTION_FAILED", errorType: ["TypeError", "RangeError", "SyntaxError", "ReferenceError"].includes(error?.name) ? error.name : "Error",
    frames: frames(error, codeRoot), memory, progress: { phase: progress.phase, scopeIndex: progress.scopeIndex, plannedScopes: progress.plannedScopes, completedParts: progress.completedParts },
    elapsedMs: Math.max(0, Date.now() - startedAt), observedAt: new Date().toISOString(), diagnosticsOnly: true }, binding);
  need(Buffer.byteLength(JSON.stringify(value)) <= MAX_BYTES); return H.writeNew(failureFile(binding.jobRoot), value);
}
async function readFailure(options) {
  try { await fs.lstat(failureFile(options.jobRoot)); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  const binding = await captureBinding(options), saved = await H.read(failureFile(options.jobRoot), MAX_BYTES), value = validate(saved.value, binding);
  if (process.platform !== "win32") need((saved.stat.mode & 0o777) === 0o600 && (typeof process.getuid !== "function" || saved.stat.uid === process.getuid()));
  const after = await captureBinding(options); need(JSON.stringify(after) === JSON.stringify(binding));
  return { status: "verified", receiptSha256: saved.sha256, code: value.code, errorType: value.errorType, frames: value.frames, memory: value.memory, progress: value.progress,
    pid: value.pid, elapsedMs: value.elapsedMs, observedAt: value.observedAt };
}
module.exports = { KIND, MAX_BYTES, PHASES, SCOPE_PHASES, failureFile, safeCode, termination, captureBinding, writePhase, writeFailure, readFailure };
