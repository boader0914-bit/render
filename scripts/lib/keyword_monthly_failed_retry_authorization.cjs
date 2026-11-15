"use strict";
// Explicit, immutable operator authorization for one extra derived attempt.
// This is not an automatic retry allowance and never changes maxAttempts.
const fs = require("node:fs/promises"), path = require("node:path");
const H = require("./keyword_monthly_refresh_preparation.cjs");
const VERSION = "keyword-monthly-incremental-v5", KIND = "keyword_monthly_operator_retry_v1";
const REASON = "KEYWORD_INCREMENTAL_REVIEWED_FAILURE_RETRY";
const FAILED_CODES = new Set(["KEYWORD_PREP_CHILD_FAILED", "KEYWORD_INCREMENTAL_CHILD_FAILED", "KEYWORD_INCREMENTAL_FAILED"]);
const CODE_FILES = Object.freeze(["reconstruct_keyword_monthly_incremental.cjs", "refresh_keyword_monthly_incremental.cjs", "launch_keyword_monthly_isolated.py",
  "build_keyword_monthly_projection.cjs", "reconstruct_keyword_monthly_source_copy.cjs",
  ...["keyword_monthly_refresh.cjs", "keyword_monthly_failed_retry_authorization.cjs", "keyword_monthly_incremental_failure.cjs", "keyword_monthly_prepared_results.cjs",
    "keyword_monthly_incremental_normalize.cjs", "keyword_monthly_source_budget.cjs", "keyword_monthly_response_budget.cjs",
    "keyword_monthly_source_relocation.cjs", "keyword_monthly_incremental_state.cjs", "keyword_monthly_incremental_context.cjs",
    "keyword_monthly_analysis.cjs", "monthly_reports.cjs", "monthly_report_comparison.cjs", "monthly_report_insights.cjs", "saved_product_recovery.cjs", "monthly_report_actions.cjs"].map(x => "lib/" + x)]);
const need = (v, c = "KEYWORD_FAILED_RETRY_AUTHORIZATION_INVALID") => H.need(v, c);
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const bytes = v => Buffer.from(JSON.stringify(v));
async function codeIdentity() {
  const root = path.resolve(__dirname, ".."), pins = [];
  for (const name of CODE_FILES) { const file = path.join(root, name), st = await H.checked(file); need(st.size > 0 && st.size <= 2 * 1024 * 1024, "KEYWORD_FAILED_RETRY_CODE_BOUND");
    const raw = await fs.readFile(file); need(H.same(st, await H.checked(file)), "KEYWORD_FAILED_RETRY_CODE_CHANGED");
    pins.push({ file: name, sha256: H.hash(raw.toString("utf8").replace(/\r\n/g, "\n")) }); }
  const guardFile = path.join(root, CODE_FILES[0]), before = await H.checked(guardFile), guard = await fs.readFile(guardFile);
  need(H.same(before, await H.checked(guardFile)), "KEYWORD_FAILED_RETRY_CODE_CHANGED");
  return { fingerprint: H.hash(bytes([KIND, pins])), guardSha256: H.hash(guard), pins };
}
function smallAuthorization(v) {
  return exact(v, ["schemaVersion", "kind", "codeFingerprint", "reviewSha256", "originalJobSha256", "authorizationSha256"])
    && v.schemaVersion === 1 && v.kind === KIND && ["codeFingerprint", "reviewSha256", "originalJobSha256", "authorizationSha256"].every(k => H.SHA.test(v[k] || ""));
}
function authorizationDirectory(dataDir, jobId, codeFingerprint) {
  need(H.SHA.test(jobId || "") && H.SHA.test(codeFingerprint || ""));
  return path.join(dataDir, "operations", "keyword-failed-calculation-retry", jobId, codeFingerprint);
}
function validRow(row) {
  if (!smallAuthorization(row?.oneShotRetry) || row.intent?.refreshVersion !== VERSION || row.maxAttempts !== 3) return false;
  if (["queued", "deferred"].includes(row.status)) return row.attempts === row.maxAttempts;
  if (row.status === "needs_verification") return [row.maxAttempts, row.maxAttempts + 1].includes(row.attempts);
  return ["running", "complete"].includes(row.status) && row.attempts === row.maxAttempts + 1;
}
async function verifyAuthorization({ dataDir, row }) {
  need(validRow(row)); const a = row.oneShotRetry, directory = authorizationDirectory(dataDir, row.jobId, a.codeFingerprint);
  const dir = await H.checked(directory, true);
  need(process.platform === "win32" || dir.uid === process.getuid() && (dir.mode & 0o777) === 0o700, "KEYWORD_FAILED_RETRY_PRIVATE_SCOPE_REQUIRED");
  const receiptFile = path.join(directory, "authorization.json"), st = await H.checked(receiptFile);
  need(process.platform === "win32" || st.uid === process.getuid() && (st.mode & 0o777) === 0o600, "KEYWORD_FAILED_RETRY_PRIVATE_SCOPE_REQUIRED");
  const r = await H.read(receiptFile, 32768), v = r.value;
  need(r.sha256 === a.authorizationSha256 && exact(v, ["schemaVersion", "kind", "action", "reason", "jobId", "refreshVersion", "codeFingerprint", "currentGuardSha256", "failedGuardSha256", "reviewSha256", "reviewedPreflightSha256", "originalJobSha256", "intent", "attempts", "maxAttempts", "authorizedAttempt", "authorizedAt", "diagnosticPurpose"])
    && v.schemaVersion === 1 && v.kind === KIND && v.action === "authorize_one_derived_attempt" && v.reason === "operator_reviewed_derived_failure_retry"
    && v.jobId === row.jobId && v.refreshVersion === VERSION && v.codeFingerprint === a.codeFingerprint && v.reviewSha256 === a.reviewSha256
    && v.originalJobSha256 === a.originalJobSha256 && JSON.stringify(v.intent) === JSON.stringify(row.intent)
    && v.attempts === 3 && v.maxAttempts === 3 && v.authorizedAttempt === 4 && H.validIso(v.authorizedAt)
    && H.SHA.test(v.failedGuardSha256 || "") && H.SHA.test(v.currentGuardSha256 || "")
    && [null, "diagnose_prior_generic_child_failure"].includes(v.diagnosticPurpose) && row.recoveredAt === v.authorizedAt);
  const originalFile = path.join(directory, "original-job.json"), originalStat = await H.checked(originalFile);
  need(process.platform === "win32" || originalStat.uid === process.getuid() && (originalStat.mode & 0o777) === 0o600, "KEYWORD_FAILED_RETRY_PRIVATE_SCOPE_REQUIRED");
  const original = await H.read(originalFile, 8192), o = original.value;
  need(original.sha256 === a.originalJobSha256 && o.jobId === row.jobId && o.status === "needs_verification" && o.attempts === 3 && o.maxAttempts === 3
    && FAILED_CODES.has(o.reasonCode) && !Object.hasOwn(o, "oneShotRetry") && JSON.stringify(o.intent) === JSON.stringify(row.intent) && row.createdAt === o.createdAt
    && (v.diagnosticPurpose === null || o.reasonCode === "KEYWORD_PREP_CHILD_FAILED"));
  const reviewed = await H.read(path.join(directory, "reviewed-preflight.json"), 32768), review = reviewed.value;
  need(reviewed.sha256 === v.reviewedPreflightSha256 && review.status === "review_required" && review.reviewSha256 === a.reviewSha256 && H.hash(bytes(review.snapshot)) === a.reviewSha256
    && review.snapshot.jobId === row.jobId && review.snapshot.originalJobSha256 === original.sha256 && review.snapshot.refreshVersion === VERSION
    && review.snapshot.codeFingerprint === a.codeFingerprint && review.snapshot.currentGuardSha256 === v.currentGuardSha256 && review.snapshot.failedGuardSha256 === v.failedGuardSha256
    && review.snapshot.attempts === 3 && review.snapshot.maxAttempts === 3 && review.snapshot.authorizedAttempt === 4 && review.snapshot.diagnosticPurpose === v.diagnosticPurpose);
  const current = await codeIdentity();
  need(current.fingerprint === v.codeFingerprint && current.guardSha256 === v.currentGuardSha256, "KEYWORD_FAILED_RETRY_CODE_CHANGED");
  need(v.currentGuardSha256 !== v.failedGuardSha256 || v.diagnosticPurpose === "diagnose_prior_generic_child_failure", "KEYWORD_FAILED_RETRY_CODE_UNCHANGED");
  need(H.same(st, await H.checked(receiptFile)) && H.identity(dir, await H.checked(directory, true)), "KEYWORD_FAILED_RETRY_AUTHORIZATION_CHANGED");
  return { authorizedAttempt: 4, codeFingerprint: current.fingerprint };
}
module.exports = { VERSION, KIND, REASON, FAILED_CODES, CODE_FILES, codeIdentity, smallAuthorization, authorizationDirectory, validRow, verifyAuthorization };
