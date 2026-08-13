"use strict";

const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const BASELINE_COMMIT = "b1ba55993ef104a698ebafa54c2309f6dc820a05";
const SOURCE_BASELINE_COMMIT = "b5de9c40199f40a4409f93b1b66f0b9ccea17a83";
const COLLECTOR_BLOB = "c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3";
const LOCKFILE_SHA256 = "ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2";
const SOURCE_MANIFEST_DIGEST = "89ed646cc3ad57bb38da577cd177d6827aeb3f008553b2c1c8a8df242e642b40";
const PHASE2_REPORT_SHA256 = "e4c2e56fc5ec9d778849f74ecb9e6043dc54b29bf8da19bf826a744795cdaec7";
const PHASE2_LIVE_JOB_DIGEST = "5514c78ecb7d367c145cf7e0bf099b9096963aec75518c624fb7712442c458bf";
const PHASE2_LIVE_PAIR_SHA256 = "1f06f3fa167f9bf3f5bc2cf67445e42d49bb9d45357efbf29cfd934b083251ab";
const LIVE_PLACE_ID_HASH = "2da4b6a5cb5efeff892338aa41ebbd81a4d9a49adf20ad414db547a041b4b20c";
const JOB_SCHEMA_VERSION = "v2-booking-business-job.v1";
const COPY_ONLY_JOB_SCHEMA_VERSION = "v2-booking-business-copy-only-job.v1";
const PAIR_SCHEMA_VERSION = "v2-booking-business-pair-result.v1";
const ENVELOPE_PARITY_SCHEMA_VERSION = "v2-booking-business-envelope-parity.v1";
const COPY_ONLY_RESULT_SCHEMA_VERSION = "v2-booking-business-copy-only-result.v1";
const SOURCE_MANIFEST_PATH = path.join(ROOT, "docs", "v2_native_main_place_source_manifest.json");
const PHASE2_REPORT_PATH = path.join(ROOT, "docs", "datalab_rebuild_phase2_report.md");
const PHASE2_LIVE_JOB_PATH = path.join(ROOT, "docs", "v2_place_artifact_live_job.proposal.json");
const PREVIOUS_LIVE_EVIDENCE_MANIFEST_PATH = path.join(ROOT, "docs", "v2_booking_business_n3_live_evidence_manifest.json");
const CHILD_PATH = path.join(ROOT, "scripts", "v2_booking_business_child.cjs");
const NETWORK_PRELOAD = path.join(ROOT, "scripts", "fixture_network_guard_preload.cjs");
const OUTPUT_ROOT = path.join(ROOT, "outputs", "rebuild-phase3");
const D1_OUTPUT_ROOT = path.join(ROOT, "outputs", "rebuild-phase3-d1");
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PREVIOUS_ORIGINAL_AUDIT_PATH = path.join(
  OUTPUT_ROOT,
  "rebuild-phase3-booking-business-live-001",
  "original",
  "audit",
  "result.json"
);
const PREVIOUS_COPIED_AUDIT_PATH = path.join(
  OUTPUT_ROOT,
  "rebuild-phase3-booking-business-live-001",
  "copied",
  "audit",
  "result.json"
);
const PREVIOUS_ORIGINAL_AUDIT_SHA256 = "bc526c061660f958903e145ecc093dae50ff211b70c44bb91dbc7524629d540e";
const PREVIOUS_COPIED_AUDIT_SHA256 = "56e9e67221478e51c9c767fae826e2eb17a77a3219a1b397bc35c9bc7b417708";
const PREVIOUS_LIVE_EVIDENCE_MANIFEST_GIT_BLOB = "a8ff8ce84b9b63d778ca315e2d2822e7f648d82b";
const PREVIOUS_LIVE_EVIDENCE_MANIFEST_CANONICAL_SHA256 = "da4cb9697ed195d54ef62f3c7e15563efbad41a0baa7dbee0b2ebef1e55e3ebf";
const EXPECTED_BOOKING_BUSINESS_ID_HASH = "e86cc58d94289c15320540e3fcfb841bf1dc780a45dba7f64af85082061e1083";
const COPY_ONLY_MINIMUM_QUIET_SECONDS = 1800;
const PREVIOUS_COPIED_AUDIT_MODIFIED_UTC = "2026-08-13T02:30:44.069Z";
const COPY_ONLY_APPROVED_JOB_SHA256 = "35875d7b67f83deff6abe46e8deb606cb6f8506fdd641030f9a829cf51fdc308";
const COPY_ONLY_EXPECTED_ENVELOPE_SHA256 = "2078ad1e1f436f524058822079837a8ab222eea7e54b375a7ad7fc2bba378d1d";
const BASELINE_PROTECTED_TREE_ENTRY_COUNT = 322;
const BASELINE_PROTECTED_TREE_SHA256 = "33c33aa6298a69eeb6223731c001a0221d6f392b9d87fd74f240585a01ab89c4";
const SHALLOW_EXPECTED_PARENT_COMMIT = "418fb262539f9a25c1c53135afcec1a8d4ae1ec8";
const SHALLOW_EXPECTED_HEAD_SOURCE_PATHS = Object.freeze([
  "docs/datalab_rebuild_phase3_d4_process_lifetime_report.md",
  "scripts/test_v2_booking_business_harness.cjs",
  "scripts/test_v2_booking_business_render_one_shot.cjs",
  "scripts/v2_booking_business_env_diagnostics.cjs",
  "scripts/v2_booking_business_harness.cjs",
  "scripts/v2_booking_business_render_one_shot.cjs"
]);
const PHASE3_FILE_ALLOWLIST = new Set([
  "docs/datalab_rebuild_phase3_d1_report.md",
  "docs/datalab_rebuild_phase3_d2_report.md",
  "docs/datalab_rebuild_phase3_d3_report.md",
  "docs/datalab_rebuild_phase3_d3_readiness_fix_report.md",
  "docs/datalab_rebuild_phase3_d3_shallow_integrity_fix_report.md",
  "docs/datalab_rebuild_phase3_d4_process_lifetime_report.md",
  "docs/datalab_rebuild_phase3_report.md",
  "docs/datalab_rebuild_phase4_prompt_draft.md",
  "docs/v2_booking_business_environment_evidence.json",
  "docs/v2_booking_business_contract.md",
  "docs/v2_booking_business_copy_only_live_job.proposal.json",
  "docs/v2_booking_business_live_job.proposal.json",
  "docs/v2_booking_business_n3_live_evidence_manifest.json",
  "docs/v2_booking_business_render_diagnostic_job.proposal.json",
  "render.v2-booking-business-render-diagnostic.proposal.yaml",
  "scripts/test_v2_booking_business_harness.cjs",
  "scripts/test_v2_booking_business_env_diagnostics.cjs",
  "scripts/test_v2_booking_business_render_one_shot.cjs",
  "scripts/v2_booking_business_child.cjs",
  "scripts/v2_booking_business_env_diagnostics.cjs",
  "scripts/v2_booking_business_harness.cjs",
  "scripts/v2_booking_business_render_network_diagnostics.cjs",
  "scripts/v2_booking_business_render_one_shot.cjs",
  "tests/fixtures/v2_booking_business_job.json"
]);
const ALLOWED_FIXTURE_SCENARIOS = new Set([
  "success",
  "zero_null_booking",
  "zero_missing_booking",
  "graphql_error",
  "malformed_booking",
  "business_null",
  "malformed_json",
  "http_403",
  "http_429",
  "http_405",
  "http_405_challenge",
  "challenge_html",
  "http_500",
  "timeout",
  "oversized"
]);

class V2BookingBusinessHarnessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "V2BookingBusinessHarnessError";
    this.code = code;
    this.retryable = false;
  }
}

function fail(code, message) {
  throw new V2BookingBusinessHarnessError(code, message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value))).digest("hex");
}

function canonicalGitTextBytes(value) {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return Buffer.from(content.toString("utf8").replace(/\r\n/gu, "\n"), "utf8");
}

function manifestRecordedTextBytes(value) {
  const canonical = canonicalGitTextBytes(value);
  return Buffer.from(canonical.toString("utf8").replace(/\n/gu, "\r\n"), "utf8");
}

function gitBlobFromBytes(value) {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return crypto.createHash("sha1")
    .update(Buffer.from(`blob ${content.length}\0`, "utf8"))
    .update(content)
    .digest("hex");
}

function verifyManifestFileBytes(content, entry) {
  const canonical = canonicalGitTextBytes(content);
  const recorded = manifestRecordedTextBytes(canonical);
  const observedGitBlob = gitBlobFromBytes(canonical);
  return Object.freeze({
    path: entry.path,
    bytes: recorded.length,
    sha256: sha256(recorded),
    gitBlob: observedGitBlob,
    matches: recorded.length === entry.bytes && sha256(recorded) === entry.sha256 && observedGitBlob === entry.gitBlob
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("V2_BOOKING_BUSINESS_JOB_INVALID", `${label} is invalid`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || !actual.every((key, index) => key === wanted[index])) {
    fail("V2_BOOKING_BUSINESS_JOB_INVALID", `${label} fields are invalid`);
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
}

function gitBlob(relative) {
  return git(["hash-object", `--path=${relative}`, relative]);
}

function gitAt(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}

function readCommitIdentity(commit = "HEAD", root = ROOT) {
  const raw = gitAt(root, ["cat-file", "-p", commit]);
  const tree = raw.match(/^tree ([0-9a-f]{40})$/mu)?.[1] || null;
  const parents = [...raw.matchAll(/^parent ([0-9a-f]{40})$/gmu)].map((match) => match[1]);
  if (!tree) fail("V2_BOOKING_BUSINESS_BASELINE_MISMATCH", "commit tree identity is unavailable");
  return Object.freeze({ commit: gitAt(root, ["rev-parse", commit]), tree, parents: Object.freeze(parents) });
}

function protectedTreeSnapshot(root = ROOT, allowedPaths = PHASE3_FILE_ALLOWLIST) {
  const entries = gitAt(root, ["ls-tree", "-r", "--full-tree", "HEAD"])
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/u);
      if (!match) fail("V2_BOOKING_BUSINESS_BASELINE_MISMATCH", "Git tree entry is invalid");
      return Object.freeze({
        mode: match[1],
        type: match[2],
        oid: match[3],
        path: match[4].replace(/\\/gu, "/")
      });
    })
    .filter((entry) => !allowedPaths.has(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path));
  const canonical = entries.map((entry) => `${entry.mode}\t${entry.type}\t${entry.oid}\t${entry.path}\n`).join("");
  return Object.freeze({ count: entries.length, sha256: sha256(canonical) });
}

function verifyCommitLineage({
  baselineCommit,
  expectedHead,
  expectedParent,
  protectedTreeEntryCount,
  protectedTreeSha256,
  mismatchCode = "V2_BOOKING_BUSINESS_BASELINE_MISMATCH",
  label = "approved baseline",
  root = ROOT,
  allowedPaths = PHASE3_FILE_ALLOWLIST,
  expectedHeadSourcePaths = SHALLOW_EXPECTED_HEAD_SOURCE_PATHS
}) {
  const head = gitAt(root, ["rev-parse", "HEAD"]);
  let baselineAvailable = true;
  try {
    execFileSync("git", ["cat-file", "-e", `${baselineCommit}^{commit}`], {
      cwd: root,
      stdio: "ignore",
      windowsHide: true
    });
  } catch {
    baselineAvailable = false;
  }
  if (baselineAvailable) {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", baselineCommit, head], {
        cwd: root,
        stdio: "ignore",
        windowsHide: true
      });
    } catch {
      fail(mismatchCode, `HEAD does not descend from the ${label}`);
    }
    return Object.freeze({ head, verification: "full-history" });
  }

  const shallow = gitAt(root, ["rev-parse", "--is-shallow-repository"]) === "true";
  if (!shallow || !expectedHead || head !== expectedHead.toLowerCase()) {
    fail(mismatchCode, `${label} is unavailable outside the approved shallow checkout`);
  }
  const identity = readCommitIdentity("HEAD", root);
  if (identity.parents.length !== 1 || identity.parents[0] !== expectedParent.toLowerCase()) {
    fail(mismatchCode, "shallow checkout HEAD parent identity changed");
  }
  const protectedTree = protectedTreeSnapshot(root, allowedPaths);
  if (protectedTree.count !== protectedTreeEntryCount || protectedTree.sha256 !== protectedTreeSha256) {
    fail(mismatchCode, "shallow checkout protected tree changed");
  }
  const protectedWorktreeDelta = gitAt(root, ["diff", "--name-only", "HEAD", "--"])
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((entry) => entry.replace(/\\/gu, "/"))
    .filter((entry) => !allowedPaths.has(entry));
  if (protectedWorktreeDelta.length) {
    fail(mismatchCode, "shallow checkout protected worktree changed");
  }
  const expectedHeadSourceBlobs = Object.freeze(expectedHeadSourcePaths.map((relative) => {
    const expectedBlob = gitAt(root, ["rev-parse", `HEAD:${relative}`]);
    const observedBlob = gitAt(root, ["hash-object", `--path=${relative}`, relative]);
    if (observedBlob !== expectedBlob) fail(mismatchCode, `shallow checkout source changed: ${relative}`);
    return Object.freeze({ path: relative, blob: expectedBlob });
  }));
  return Object.freeze({ head, verification: "shallow-pinned-head-parent-protected-tree", protectedTree, expectedHeadSourceBlobs });
}

function normalizeJob(value) {
  exactKeys(value, [
    "schemaVersion",
    "runId",
    "mode",
    "placeId",
    "source",
    "checkIn",
    "adults",
    "timeoutMs",
    "responseSizeLimitBytes",
    "fixtureScenario"
  ], "job");
  exactKeys(value.source, ["kind", "phase2PairSha256", "rank"], "job source");
  const runId = String(value.runId || "");
  const mode = String(value.mode || "");
  const placeId = String(value.placeId || "").trim();
  const sourceKind = String(value.source.kind || "");
  const checkIn = String(value.checkIn || "");
  const adults = Number(value.adults);
  const timeoutMs = Number(value.timeoutMs);
  const responseSizeLimitBytes = Number(value.responseSizeLimitBytes);
  const fixtureScenario = String(value.fixtureScenario || "");
  if (
    value.schemaVersion !== JOB_SCHEMA_VERSION
    || !/^rebuild-phase3-booking-business-(?:offline|live)-\d{3}$/u.test(runId)
    || !["offline", "live"].includes(mode)
    || !/^\d{1,30}$/u.test(placeId)
    || !/^\d{4}-\d{2}-\d{2}$/u.test(checkIn)
    || Number.isNaN(Date.parse(`${checkIn}T00:00:00Z`))
    || !Number.isInteger(adults)
    || adults < 1
    || adults > 20
    || !Number.isInteger(timeoutMs)
    || timeoutMs < 25
    || timeoutMs > 25_000
    || !Number.isInteger(responseSizeLimitBytes)
    || responseSizeLimitBytes < 1024
    || responseSizeLimitBytes > MAX_RESPONSE_BYTES
  ) fail("V2_BOOKING_BUSINESS_JOB_INVALID", "job values are invalid");
  if (mode === "offline") {
    if (
      sourceKind !== "synthetic_fixture"
      || value.source.phase2PairSha256 !== null
      || value.source.rank !== null
      || !ALLOWED_FIXTURE_SCENARIOS.has(fixtureScenario)
    ) fail("V2_BOOKING_BUSINESS_JOB_INVALID", "offline source contract is invalid");
  } else if (
    sourceKind !== "phase2_live_natural_rank"
    || value.source.phase2PairSha256 !== PHASE2_LIVE_PAIR_SHA256
    || value.source.rank !== 1
    || fixtureScenario !== "none"
    || sha256(placeId) !== LIVE_PLACE_ID_HASH
    || timeoutMs !== 25_000
    || responseSizeLimitBytes !== MAX_RESPONSE_BYTES
  ) fail("V2_BOOKING_BUSINESS_JOB_INVALID", "live source contract is invalid");
  return Object.freeze({
    schemaVersion: JOB_SCHEMA_VERSION,
    runId,
    mode,
    placeId,
    source: Object.freeze({ kind: sourceKind, phase2PairSha256: value.source.phase2PairSha256, rank: value.source.rank }),
    checkIn,
    adults,
    timeoutMs,
    responseSizeLimitBytes,
    fixtureScenario
  });
}

async function readJob(jobPath) {
  const bytes = await fs.readFile(path.resolve(jobPath));
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("V2_BOOKING_BUSINESS_JOB_INVALID", "job JSON is invalid");
  }
  const job = normalizeJob(parsed);
  return Object.freeze({ job, digest: sha256(stableJson(job)) });
}

function normalizeCopyOnlyJob(value) {
  exactKeys(value, [
    "schemaVersion",
    "runId",
    "mode",
    "placeId",
    "source",
    "checkIn",
    "adults",
    "timeoutMs",
    "responseSizeLimitBytes",
    "notBefore",
    "expectedEnvelopeSha256",
    "expectedBookingBusinessIdHash",
    "previousOriginalAuditSha256",
    "previousCopiedAuditSha256"
  ], "copy-only job");
  exactKeys(value.source, ["kind", "phase2PairSha256", "rank"], "copy-only job source");
  const placeId = String(value.placeId || "").trim();
  const notBefore = String(value.notBefore || "");
  const notBeforeDate = new Date(notBefore);
  if (
    value.schemaVersion !== COPY_ONLY_JOB_SCHEMA_VERSION
    || value.runId !== "rebuild-phase3-booking-business-copy-only-live-001"
    || value.mode !== "copy-only-live"
    || !/^\d{1,30}$/u.test(placeId)
    || sha256(placeId) !== LIVE_PLACE_ID_HASH
    || value.source?.kind !== "phase2_live_natural_rank"
    || value.source?.phase2PairSha256 !== PHASE2_LIVE_PAIR_SHA256
    || value.source?.rank !== 1
    || !/^\d{4}-\d{2}-\d{2}$/u.test(String(value.checkIn || ""))
    || Number.isNaN(Date.parse(`${value.checkIn}T00:00:00Z`))
    || value.adults !== 2
    || value.timeoutMs !== 25_000
    || value.responseSizeLimitBytes !== MAX_RESPONSE_BYTES
    || !Number.isFinite(notBeforeDate.getTime())
    || notBeforeDate.toISOString() !== notBefore
    || !/^[a-f0-9]{64}$/u.test(String(value.expectedEnvelopeSha256 || ""))
    || value.expectedEnvelopeSha256 !== COPY_ONLY_EXPECTED_ENVELOPE_SHA256
    || value.expectedBookingBusinessIdHash !== EXPECTED_BOOKING_BUSINESS_ID_HASH
    || value.previousOriginalAuditSha256 !== PREVIOUS_ORIGINAL_AUDIT_SHA256
    || value.previousCopiedAuditSha256 !== PREVIOUS_COPIED_AUDIT_SHA256
  ) fail("V2_BOOKING_BUSINESS_COPY_ONLY_JOB_INVALID", "copy-only job contract is invalid");
  return Object.freeze({
    schemaVersion: COPY_ONLY_JOB_SCHEMA_VERSION,
    runId: value.runId,
    mode: value.mode,
    placeId,
    source: Object.freeze({ ...value.source }),
    checkIn: value.checkIn,
    adults: value.adults,
    timeoutMs: value.timeoutMs,
    responseSizeLimitBytes: value.responseSizeLimitBytes,
    notBefore,
    expectedEnvelopeSha256: value.expectedEnvelopeSha256,
    expectedBookingBusinessIdHash: value.expectedBookingBusinessIdHash,
    previousOriginalAuditSha256: value.previousOriginalAuditSha256,
    previousCopiedAuditSha256: value.previousCopiedAuditSha256
  });
}

async function readCopyOnlyJob(jobPath) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(path.resolve(jobPath), "utf8"));
  } catch {
    fail("V2_BOOKING_BUSINESS_COPY_ONLY_JOB_INVALID", "copy-only job JSON is invalid");
  }
  const job = normalizeCopyOnlyJob(parsed);
  return Object.freeze({ job, digest: sha256(stableJson(job)) });
}

async function verifyBaseline() {
  const expectedHead = String(process.env.V2_RENDER_DIAGNOSTIC_EXPECTED_DEPLOY_COMMIT || "").trim().toLowerCase() || null;
  const lineage = verifyCommitLineage({
    baselineCommit: BASELINE_COMMIT,
    expectedHead,
    expectedParent: SHALLOW_EXPECTED_PARENT_COMMIT,
    protectedTreeEntryCount: BASELINE_PROTECTED_TREE_ENTRY_COUNT,
    protectedTreeSha256: BASELINE_PROTECTED_TREE_SHA256,
    label: "N2 baseline commit"
  });
  const head = lineage.head;
  if (lineage.verification === "full-history") {
    const committedDelta = git(["diff", "--name-only", BASELINE_COMMIT, head, "--"])
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((entry) => entry.replace(/\\/gu, "/"));
    const forbiddenDelta = committedDelta.filter((entry) => !PHASE3_FILE_ALLOWLIST.has(entry));
    if (forbiddenDelta.length) {
      fail("V2_BOOKING_BUSINESS_BASELINE_MISMATCH", "HEAD contains files outside the Phase 3 allowlist");
    }
  }
  const sourceManifest = JSON.parse(await fs.readFile(SOURCE_MANIFEST_PATH, "utf8"));
  if (
    sourceManifest.baselineCommit !== SOURCE_BASELINE_COMMIT
    || sourceManifest.baselineCollectorBlob !== COLLECTOR_BLOB
    || sourceManifest.files?.length !== 20
    || sha256(stableJson(sourceManifest)) !== SOURCE_MANIFEST_DIGEST
  ) fail("V2_BOOKING_BUSINESS_SOURCE_MANIFEST_MISMATCH", "source manifest identity changed");
  const sourceFiles = [];
  for (const entry of sourceManifest.files) {
    const content = await fs.readFile(path.join(ROOT, entry.path));
    const observed = verifyManifestFileBytes(content, entry);
    if (!observed.matches || gitBlob(entry.path) !== entry.gitBlob) {
      fail("V2_BOOKING_BUSINESS_SOURCE_FILE_MISMATCH", `baseline source changed: ${entry.path}`);
    }
    sourceFiles.push(observed);
  }
  if (lineage.verification === "full-history") {
    const changed = git(["diff", "--name-only", BASELINE_COMMIT, "--", ...sourceManifest.files.map((entry) => entry.path)]);
    if (changed) fail("V2_BOOKING_BUSINESS_SOURCE_FILE_MISMATCH", "one or more baseline source files have a diff");
  }
  if (gitBlob("scripts/gyeongnam_glamping_crawl.cjs") !== COLLECTOR_BLOB) {
    fail("V2_BOOKING_BUSINESS_COLLECTOR_MISMATCH", "collector blob changed");
  }
  const lockfileEntry = sourceManifest.files.find((entry) => entry.path === "package-lock.json");
  const lockfileBytes = await fs.readFile(path.join(ROOT, "package-lock.json"));
  if (!lockfileEntry || !verifyManifestFileBytes(lockfileBytes, lockfileEntry).matches) {
    fail("V2_BOOKING_BUSINESS_LOCKFILE_MISMATCH", "package-lock changed");
  }
  const lockfileSha256 = LOCKFILE_SHA256;
  const phase2ReportSha256 = sha256(manifestRecordedTextBytes(await fs.readFile(PHASE2_REPORT_PATH)));
  if (phase2ReportSha256 !== PHASE2_REPORT_SHA256) fail("V2_BOOKING_BUSINESS_PHASE2_EVIDENCE_MISMATCH", "Phase 2 report changed");
  const phase2Job = normalizePhase2Job(JSON.parse(await fs.readFile(PHASE2_LIVE_JOB_PATH, "utf8")));
  if (sha256(stableJson(phase2Job)) !== PHASE2_LIVE_JOB_DIGEST) {
    fail("V2_BOOKING_BUSINESS_PHASE2_EVIDENCE_MISMATCH", "Phase 2 live job changed");
  }
  return Object.freeze({
    baselineCommit: BASELINE_COMMIT,
    head,
    collectorBlob: COLLECTOR_BLOB,
    lockfileSha256,
    sourceManifestDigest: SOURCE_MANIFEST_DIGEST,
    sourceFileCount: sourceFiles.length,
    sourceBaselineCommit: SOURCE_BASELINE_COMMIT,
    phase2ReportSha256,
    phase2LiveJobDigest: PHASE2_LIVE_JOB_DIGEST,
    phase2LivePairSha256: PHASE2_LIVE_PAIR_SHA256,
    lineageVerification: lineage.verification,
    expectedHeadSourceBlobs: lineage.expectedHeadSourceBlobs || Object.freeze([])
  });
}

function normalizePhase2Job(value) {
  const copy = JSON.parse(JSON.stringify(value));
  return copy;
}

function isolatedRunRoot(runId) {
  const resolved = path.resolve(OUTPUT_ROOT, runId);
  const relative = path.relative(path.resolve(OUTPUT_ROOT), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("V2_BOOKING_BUSINESS_OUTPUT_PATH_INVALID", "evidence root escaped the Phase 3 output root");
  }
  return resolved;
}

function isolatedD1RunRoot(runId) {
  const resolved = path.resolve(D1_OUTPUT_ROOT, runId);
  const relative = path.relative(path.resolve(D1_OUTPUT_ROOT), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("V2_BOOKING_BUSINESS_OUTPUT_PATH_INVALID", "evidence root escaped the Phase 3 D1 output root");
  }
  return resolved;
}

async function verifyPreviousLiveEvidence() {
  const manifestBytes = await fs.readFile(PREVIOUS_LIVE_EVIDENCE_MANIFEST_PATH);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    gitBlob("docs/v2_booking_business_n3_live_evidence_manifest.json") !== PREVIOUS_LIVE_EVIDENCE_MANIFEST_GIT_BLOB
    || sha256(stableJson(manifest)) !== PREVIOUS_LIVE_EVIDENCE_MANIFEST_CANONICAL_SHA256
    ||
    manifest.schemaVersion !== "v2-booking-business-n3-live-evidence.v1"
    || manifest.runId !== "rebuild-phase3-booking-business-live-001"
    || manifest.original?.auditSha256 !== PREVIOUS_ORIGINAL_AUDIT_SHA256
    || manifest.original?.providerStatus !== 200
    || manifest.original?.classification !== "resolved"
    || manifest.original?.bookingBusinessIdHash !== EXPECTED_BOOKING_BUSINESS_ID_HASH
    || manifest.original?.actualExternalRequests !== 1
    || manifest.copied?.auditSha256 !== PREVIOUS_COPIED_AUDIT_SHA256
    || manifest.copied?.modifiedUtc !== PREVIOUS_COPIED_AUDIT_MODIFIED_UTC
    || manifest.copied?.providerStatus !== 405
    || manifest.copied?.errorCode !== "NAVER_ACCESS_BLOCKED"
    || manifest.copied?.actualExternalRequests !== 1
    || manifest.totalExternalRequests !== 2
    || manifest.retries !== 0
    || manifest.fallbacks !== 0
    || manifest.operationalWrites !== 0
    || manifest.rawProviderResponsesStored !== false
  ) fail("V2_BOOKING_BUSINESS_PREVIOUS_EVIDENCE_MISMATCH", "previous N3 live result contract changed");
  let localEvidenceCrossChecked = false;
  if (fsSync.existsSync(PREVIOUS_ORIGINAL_AUDIT_PATH) || fsSync.existsSync(PREVIOUS_COPIED_AUDIT_PATH)) {
    if (!fsSync.existsSync(PREVIOUS_ORIGINAL_AUDIT_PATH) || !fsSync.existsSync(PREVIOUS_COPIED_AUDIT_PATH)) {
      fail("V2_BOOKING_BUSINESS_PREVIOUS_EVIDENCE_MISMATCH", "local N3 evidence is incomplete");
    }
    const [originalBytes, copiedBytes, copiedStat] = await Promise.all([
      fs.readFile(PREVIOUS_ORIGINAL_AUDIT_PATH),
      fs.readFile(PREVIOUS_COPIED_AUDIT_PATH),
      fs.stat(PREVIOUS_COPIED_AUDIT_PATH)
    ]);
    const original = JSON.parse(originalBytes.toString("utf8"));
    const copied = JSON.parse(copiedBytes.toString("utf8"));
    if (
      sha256(originalBytes) !== PREVIOUS_ORIGINAL_AUDIT_SHA256
      || sha256(copiedBytes) !== PREVIOUS_COPIED_AUDIT_SHA256
      || original.providerStatus !== manifest.original.providerStatus
      || original.classification !== manifest.original.classification
      || original.bookingBusinessIdHash !== manifest.original.bookingBusinessIdHash
      || original.calls?.actualExternal !== manifest.original.actualExternalRequests
      || copied.providerStatus !== manifest.copied.providerStatus
      || copied.error?.code !== manifest.copied.errorCode
      || copied.calls?.actualExternal !== manifest.copied.actualExternalRequests
      || copiedStat.mtime.toISOString() !== manifest.copied.modifiedUtc
    ) fail("V2_BOOKING_BUSINESS_PREVIOUS_EVIDENCE_MISMATCH", "local N3 evidence does not match its committed manifest");
    localEvidenceCrossChecked = true;
  }
  return Object.freeze({
    manifestGitBlob: PREVIOUS_LIVE_EVIDENCE_MANIFEST_GIT_BLOB,
    manifestCanonicalSha256: PREVIOUS_LIVE_EVIDENCE_MANIFEST_CANONICAL_SHA256,
    originalAuditSha256: PREVIOUS_ORIGINAL_AUDIT_SHA256,
    copiedAuditSha256: PREVIOUS_COPIED_AUDIT_SHA256,
    expectedBookingBusinessIdHash: EXPECTED_BOOKING_BUSINESS_ID_HASH,
    copiedAuditModifiedUtc: manifest.copied.modifiedUtc,
    localEvidenceCrossChecked
  });
}

function verifyRuntime() {
  const runtime = Object.freeze({
    nodeVersion: process.version,
    undiciVersion: process.versions.undici || null,
    platform: process.platform,
    architecture: process.arch
  });
  if (runtime.nodeVersion !== "v26.5.0" || runtime.undiciVersion !== "8.7.0") {
    fail("V2_BOOKING_BUSINESS_RUNTIME_MISMATCH", "Node 26.5.0 with bundled Undici 8.7.0 is required");
  }
  return runtime;
}

async function materializeCopy(sourceManifest, snapshotRoot) {
  for (const entry of sourceManifest.files) {
    const source = path.join(ROOT, entry.path);
    const target = path.join(snapshotRoot, entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    if (!verifyManifestFileBytes(await fs.readFile(target), entry).matches) {
      fail("V2_BOOKING_BUSINESS_COPY_HASH_MISMATCH", `copied source hash mismatch: ${entry.path}`);
    }
  }
}

function safeSystemEnvironment() {
  const result = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA"]) {
    if (process.env[name]) result[name] = process.env[name];
  }
  return result;
}

function childEnvironment({ moduleRoot, job, transportMode, replayFile, jobDigest, expectedEnvelopeSha256 = "" }) {
  const offline = transportMode !== "live";
  return {
    ...safeSystemEnvironment(),
    NODE_OPTIONS: offline ? `--require=${NETWORK_PRELOAD.replace(/\\/gu, "/")}` : "",
    NODE_ENV: offline ? "test" : "production",
    V2_BOOKING_BUSINESS_SOURCE_ROOT: moduleRoot,
    V2_BOOKING_BUSINESS_PLACE_ID: job.placeId,
    V2_BOOKING_BUSINESS_CHECK_IN: job.checkIn,
    V2_BOOKING_BUSINESS_ADULTS: String(job.adults),
    V2_BOOKING_BUSINESS_TIMEOUT_MS: String(job.timeoutMs),
    V2_BOOKING_BUSINESS_RESPONSE_LIMIT_BYTES: String(job.responseSizeLimitBytes),
    V2_BOOKING_BUSINESS_TRANSPORT_MODE: transportMode,
    V2_BOOKING_BUSINESS_FIXTURE_SCENARIO: job.fixtureScenario === "none" ? "success" : job.fixtureScenario,
    V2_BOOKING_BUSINESS_REPLAY_FILE: replayFile || "",
    V2_BOOKING_BUSINESS_LIVE_APPROVED: transportMode === "live" ? "N3-Copy-Only-Live" : "",
    V2_BOOKING_BUSINESS_APPROVED_JOB_SHA256: transportMode === "live" ? jobDigest : "",
    V2_BOOKING_BUSINESS_EXPECTED_ENVELOPE_SHA256: transportMode === "live" ? expectedEnvelopeSha256 : "",
    NAVER_AUTOMATIC_RETRY: "0",
    NAVER_AUTOMATIC_FALLBACK: "0",
    NAVER_BOOKING_ID_FALLBACK: "0",
    NAVER_COUPON_PAGE_FALLBACK: "0"
  };
}

function runChild({ moduleRoot, job, transportMode, replayFile = "", jobDigest, expectedEnvelopeSha256 = "" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD_PATH], {
      cwd: moduleRoot,
      env: childEnvironment({ moduleRoot, job, transportMode, replayFile, jobDigest, expectedEnvelopeSha256 }),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current, chunk) => `${current}${chunk}`.slice(-500_000);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(job.timeoutMs + 5_000, 7_500));
    timer.unref?.();
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout, stderr });
    });
  });
}

function parseChild(child) {
  const lines = String(child.stdout || "").trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) {
    fail(
      "V2_BOOKING_BUSINESS_CHILD_RESULT_INVALID",
      `child result framing is invalid (stdoutLines=${lines.length}, stdoutBytes=${Buffer.byteLength(child.stdout || "")}, stderrBytes=${Buffer.byteLength(child.stderr || "")}, exitCode=${child.exitCode ?? "null"})`
    );
  }
  let result;
  try {
    result = JSON.parse(lines[0]);
  } catch {
    fail("V2_BOOKING_BUSINESS_CHILD_RESULT_INVALID", "child result JSON is invalid");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    fail("V2_BOOKING_BUSINESS_CHILD_RESULT_INVALID", "child result is invalid");
  }
  return result;
}

function resultProjection(result) {
  return Object.freeze({
    status: result.status,
    classification: result.classification,
    placeIdHash: result.placeIdHash || null,
    bookingBusinessIdHash: result.bookingBusinessIdHash || null,
    bookingUrlPresent: result.bookingUrlPresent === true,
    providerConfirmedZero: result.providerConfirmedZero === true,
    providerErrors: result.providerErrors === true,
    providerStatus: Number.isInteger(result.providerStatus) ? result.providerStatus : null,
    responseDiagnostic: result.responseDiagnostic || null,
    error: result.error ? {
      code: String(result.error.code || ""),
      retryable: Boolean(result.error.retryable),
      providerFailureSubtype: result.error.providerFailureSubtype || null,
      providerHttpStatus: Number.isInteger(result.error.providerHttpStatus) ? result.error.providerHttpStatus : null,
      retryAfterSeconds: Number.isInteger(result.error.retryAfterSeconds) ? result.error.retryAfterSeconds : null
    } : null,
    runtime: result.runtime || null,
    sourceFunctionDigest: result.sourceFunctionDigest || null,
    querySha256: result.querySha256 || null,
    request: result.request || null,
    calls: result.calls,
    concurrency: result.concurrency ?? null,
    retries: result.retries,
    fallbacks: result.fallbacks,
    htmlFallbackCalls: result.htmlFallbackCalls,
    historicalFallbackReads: result.historicalFallbackReads,
    operationalWrites: result.operationalWrites,
    rawProviderResponseStored: result.rawProviderResponseStored,
    headersStored: result.headersStored,
    fullRequestUrlStored: result.fullRequestUrlStored
  });
}

function assertOneCallResult(result, transportMode) {
  const expectedExternal = transportMode === "live" ? 1 : 0;
  const expectedFixture = transportMode === "live" ? 0 : 1;
  if (
    result.calls?.bookingBusiness !== 1
    || result.calls?.bookingItems !== 0
    || result.calls?.dailySchedule !== 0
    || result.calls?.total !== 1
    || result.calls?.actualExternal !== expectedExternal
    || result.calls?.fixture !== expectedFixture
    || result.retries !== 0
    || result.fallbacks !== 0
    || result.htmlFallbackCalls !== 0
    || result.historicalFallbackReads !== 0
    || result.operationalWrites !== 0
    || result.rawProviderResponseStored !== false
    || result.headersStored !== false
    || result.fullRequestUrlStored !== false
  ) fail("V2_BOOKING_BUSINESS_CHILD_AUDIT_INVALID", "child escaped the booking-business-only contract");
}

async function atomicJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await fs.rename(temporary, filePath);
}

async function executeTarget({ moduleRoot, targetRoot, job, transportMode, replayFile, jobDigest, expectedEnvelopeSha256 = "" }) {
  await fs.mkdir(targetRoot, { recursive: false });
  const child = await runChild({ moduleRoot, job, transportMode, replayFile, jobDigest, expectedEnvelopeSha256 });
  const result = parseChild(child);
  if (child.exitCode !== 0 || child.signal || child.timedOut) {
    fail("V2_BOOKING_BUSINESS_CHILD_FAILED", `child process failed: ${result.error?.code || "unknown"}`);
  }
  assertOneCallResult(result, transportMode);
  const projection = resultProjection(result);
  await atomicJson(path.join(targetRoot, "audit", "result.json"), projection);
  return Object.freeze({ child, result, projection });
}

function compareTargets(original, replay, copied, mode) {
  const comparable = (projection) => ({
    status: projection.status,
    classification: projection.classification,
    placeIdHash: projection.placeIdHash,
    bookingBusinessIdHash: projection.bookingBusinessIdHash,
    bookingUrlPresent: projection.bookingUrlPresent,
    providerConfirmedZero: projection.providerConfirmedZero,
    providerErrors: projection.providerErrors,
    providerStatus: projection.providerStatus,
    error: projection.error,
    sourceFunctionDigest: projection.sourceFunctionDigest,
    querySha256: projection.querySha256,
    request: projection.request,
    bookingItems: projection.calls.bookingItems,
    dailySchedule: projection.calls.dailySchedule,
    retries: projection.retries,
    fallbacks: projection.fallbacks,
    htmlFallbackCalls: projection.htmlFallbackCalls,
    historicalFallbackReads: projection.historicalFallbackReads
  });
  const replayExact = stableJson(comparable(original)) === stableJson(comparable(replay));
  const copyStructural = stableJson(comparable(original)) === stableJson(comparable(copied));
  const independentExact = stableJson(comparable(original)) === stableJson(comparable(copied));
  return Object.freeze({
    schemaVersion: "v2-booking-business-comparison.v1",
    replayExactParity: replayExact,
    copiedStructuralParity: copyStructural,
    copiedExactParity: mode === "offline" ? independentExact : null,
    liveObservation: mode === "live" ? {
      classificationPair: [original.classification, copied.classification],
      bookingBusinessIdHashMatch: original.bookingBusinessIdHash === copied.bookingBusinessIdHash,
      bookingUrlPresencePair: [original.bookingUrlPresent, copied.bookingUrlPresent]
    } : null
  });
}

async function runPair(jobPath) {
  const [{ job, digest: jobDigest }, baseline] = await Promise.all([readJob(jobPath), verifyBaseline()]);
  if (job.mode === "live") {
    fail("V2_BOOKING_BUSINESS_PAIR_LIVE_CLOSED", "the original-plus-copy live pair is permanently disabled after N3-Live");
  }
  const runRoot = isolatedRunRoot(job.runId);
  if (fsSync.existsSync(runRoot)) fail("V2_BOOKING_BUSINESS_RUN_EXISTS", "run ID already exists");
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });
  await fs.mkdir(runRoot, { recursive: false });
  try {
    const sourceManifest = JSON.parse(await fs.readFile(SOURCE_MANIFEST_PATH, "utf8"));
    const copiedRoot = path.join(runRoot, "copied-source");
    await materializeCopy(sourceManifest, copiedRoot);
    const original = await executeTarget({
      moduleRoot: ROOT,
      targetRoot: path.join(runRoot, "original"),
      job,
      transportMode: job.mode === "live" ? "live" : "fixture",
      replayFile: "",
      jobDigest
    });
    if (job.mode === "live" && !["resolved", "zero"].includes(original.projection.classification)) {
      fail("V2_BOOKING_BUSINESS_LIVE_ORIGINAL_NOT_TERMINAL", "original live lookup was not resolved or provider-confirmed zero");
    }
    const replayFile = path.join(runRoot, "replay", "input", "sanitized-replay.json");
    await atomicJson(replayFile, original.result.sanitizedReplay);
    const replay = await executeTarget({
      moduleRoot: copiedRoot,
      targetRoot: path.join(runRoot, "replay", "execution"),
      job,
      transportMode: "replay",
      replayFile,
      jobDigest
    });
    const copied = await executeTarget({
      moduleRoot: copiedRoot,
      targetRoot: path.join(runRoot, "copied"),
      job,
      transportMode: job.mode === "live" ? "live" : "fixture",
      replayFile: "",
      jobDigest
    });
    const comparison = compareTargets(original.projection, replay.projection, copied.projection, job.mode);
    if (!comparison.replayExactParity || !comparison.copiedStructuralParity) {
      fail("V2_BOOKING_BUSINESS_PARITY_MISMATCH", "booking-business parity failed");
    }
    if (job.mode === "offline" && !comparison.copiedExactParity) {
      fail("V2_BOOKING_BUSINESS_FIXTURE_PARITY_MISMATCH", "offline original/copy parity failed");
    }
    const externalRequestCount = original.projection.calls.actualExternal
      + replay.projection.calls.actualExternal
      + copied.projection.calls.actualExternal;
    const pairResult = Object.freeze({
      schemaVersion: PAIR_SCHEMA_VERSION,
      runId: job.runId,
      mode: job.mode,
      baseline,
      jobApprovalDigest: jobDigest,
      input: {
        placeIdHash: sha256(job.placeId),
        source: job.source,
        checkIn: job.checkIn,
        adults: job.adults
      },
      requestContract: {
        method: "POST",
        origin: "https://pcmap-api.place.naver.com",
        path: "/graphql",
        operationName: "naverBookingBusiness",
        variableNames: ["id", "isNx"],
        targetRequestBudget: 1,
        pairExternalRequestBudget: 2,
        timeoutMs: job.timeoutMs,
        responseSizeLimitBytes: job.responseSizeLimitBytes,
        retries: 0,
        fallbacks: 0
      },
      original: original.projection,
      replay: replay.projection,
      copied: copied.projection,
      comparison,
      classification: {
        nativeV2Artifact: false,
        comparisonOnly: ["normalized identity audit", "sanitized replay", "pair result"],
        eventualNativeFields: ["네이버예약사업자ID", "네이버예약URL"]
      },
      externalRequestCount,
      placeListRequests: 0,
      bookingBusinessRequests: original.projection.calls.bookingBusiness + copied.projection.calls.bookingBusiness,
      bookingItemsRequests: 0,
      dailyScheduleRequests: 0,
      htmlFallbackRequests: 0,
      historicalFallbackReads: 0,
      retries: 0,
      fallbacks: 0,
      operationalWrites: 0,
      rawProviderResponsesStored: false
    });
    await atomicJson(path.join(runRoot, "pair-result.json"), pairResult);
    return pairResult;
  } catch (error) {
    await atomicJson(path.join(runRoot, "failure.json"), {
      schemaVersion: "v2-booking-business-failure.v1",
      code: String(error?.code || "V2_BOOKING_BUSINESS_FAILED"),
      retryable: false
    }).catch(() => {});
    throw error;
  }
}

function diagnosticFixtureJob(copyOnlyJob) {
  return normalizeJob({
    schemaVersion: JOB_SCHEMA_VERSION,
    runId: "rebuild-phase3-booking-business-offline-002",
    mode: "offline",
    placeId: copyOnlyJob.placeId,
    source: { kind: "synthetic_fixture", phase2PairSha256: null, rank: null },
    checkIn: copyOnlyJob.checkIn,
    adults: copyOnlyJob.adults,
    timeoutMs: copyOnlyJob.timeoutMs,
    responseSizeLimitBytes: copyOnlyJob.responseSizeLimitBytes,
    fixtureScenario: "success"
  });
}

async function runEnvelopeParity(jobPath) {
  const [{ job, digest: jobDigest }, baseline, previousEvidence] = await Promise.all([
    readCopyOnlyJob(jobPath),
    verifyBaseline(),
    verifyPreviousLiveEvidence()
  ]);
  const runtime = verifyRuntime();
  if (
    jobDigest !== COPY_ONLY_APPROVED_JOB_SHA256
    || job.expectedEnvelopeSha256 !== COPY_ONLY_EXPECTED_ENVELOPE_SHA256
  ) fail("V2_BOOKING_BUSINESS_COPY_ONLY_JOB_MISMATCH", "copy-only job identity is not frozen in code");
  const runId = "rebuild-phase3-booking-business-envelope-offline-001";
  const runRoot = isolatedD1RunRoot(runId);
  if (fsSync.existsSync(runRoot)) fail("V2_BOOKING_BUSINESS_RUN_EXISTS", "D1 envelope run ID already exists");
  await fs.mkdir(D1_OUTPUT_ROOT, { recursive: true });
  await fs.mkdir(runRoot, { recursive: false });
  try {
    const sourceManifest = JSON.parse(await fs.readFile(SOURCE_MANIFEST_PATH, "utf8"));
    const copiedRoot = path.join(runRoot, "copied-source");
    await materializeCopy(sourceManifest, copiedRoot);
    const fixtureJob = diagnosticFixtureJob(job);
    const fixtureDigest = sha256(stableJson(fixtureJob));
    const original = await executeTarget({
      moduleRoot: ROOT,
      targetRoot: path.join(runRoot, "original"),
      job: fixtureJob,
      transportMode: "fixture",
      replayFile: "",
      jobDigest: fixtureDigest
    });
    const copied = await executeTarget({
      moduleRoot: copiedRoot,
      targetRoot: path.join(runRoot, "copied"),
      job: fixtureJob,
      transportMode: "fixture",
      replayFile: "",
      jobDigest: fixtureDigest
    });
    const originalEnvelope = original.projection.request?.fetchEnvelope;
    const copiedEnvelope = copied.projection.request?.fetchEnvelope;
    const exactEnvelopeParity = stableJson(originalEnvelope) === stableJson(copiedEnvelope);
    if (
      !exactEnvelopeParity
      || originalEnvelope?.envelopeSha256 !== COPY_ONLY_EXPECTED_ENVELOPE_SHA256
      || original.projection.runtime?.nodeVersion !== runtime.nodeVersion
      || copied.projection.runtime?.nodeVersion !== runtime.nodeVersion
      || original.projection.runtime?.undiciVersion !== runtime.undiciVersion
      || copied.projection.runtime?.undiciVersion !== runtime.undiciVersion
      || original.projection.calls.actualExternal !== 0
      || copied.projection.calls.actualExternal !== 0
    ) fail("V2_BOOKING_BUSINESS_ENVELOPE_PARITY_MISMATCH", "original and copied application fetch envelopes differ");
    const result = Object.freeze({
      schemaVersion: ENVELOPE_PARITY_SCHEMA_VERSION,
      status: "passed",
      runId,
      baseline,
      previousEvidence,
      runtime,
      copyOnlyJobDigest: jobDigest,
      applicationEnvelopeSha256: originalEnvelope.envelopeSha256,
      exactEnvelopeParity,
      original: {
        sourceFunctionDigest: original.projection.sourceFunctionDigest,
        querySha256: original.projection.querySha256,
        requestEnvelope: originalEnvelope,
        actualExternalRequests: original.projection.calls.actualExternal
      },
      copied: {
        sourceFunctionDigest: copied.projection.sourceFunctionDigest,
        querySha256: copied.projection.querySha256,
        requestEnvelope: copiedEnvelope,
        actualExternalRequests: copied.projection.calls.actualExternal
      },
      retries: 0,
      fallbacks: 0,
      operationalWrites: 0,
      rawProviderResponsesStored: false,
      requestHeaderValuesStored: false,
      requestBodiesStored: false
    });
    await atomicJson(path.join(runRoot, "envelope-parity-result.json"), result);
    return result;
  } catch (error) {
    await atomicJson(path.join(runRoot, "failure.json"), {
      schemaVersion: "v2-booking-business-d1-failure.v1",
      code: String(error?.code || "V2_BOOKING_BUSINESS_D1_FAILED"),
      retryable: false
    }).catch(() => {});
    throw error;
  }
}

async function runCopyOnlyLive(jobPath) {
  const [{ job, digest: jobDigest }, baseline, previousEvidence] = await Promise.all([
    readCopyOnlyJob(jobPath),
    verifyBaseline(),
    verifyPreviousLiveEvidence()
  ]);
  const runtime = verifyRuntime();
  if (
    jobDigest !== COPY_ONLY_APPROVED_JOB_SHA256
    || job.expectedEnvelopeSha256 !== COPY_ONLY_EXPECTED_ENVELOPE_SHA256
  ) fail("V2_BOOKING_BUSINESS_COPY_ONLY_JOB_MISMATCH", "copy-only job identity is not frozen in code");
  if (
    process.env.V2_BOOKING_BUSINESS_LIVE_APPROVED !== "N3-Copy-Only-Live"
    || process.env.V2_BOOKING_BUSINESS_LIVE_REQUEST_BUDGET !== "1"
    || process.env.V2_BOOKING_BUSINESS_APPROVED_JOB_SHA256 !== COPY_ONLY_APPROVED_JOB_SHA256
    || process.env.V2_BOOKING_BUSINESS_EXPECTED_ENVELOPE_SHA256 !== COPY_ONLY_EXPECTED_ENVELOPE_SHA256
  ) fail("V2_BOOKING_BUSINESS_LIVE_NOT_APPROVED", "copy-only live gates do not match the frozen job and envelope");
  const minimumNotBefore = new Date(
    new Date(previousEvidence.copiedAuditModifiedUtc).getTime() + COPY_ONLY_MINIMUM_QUIET_SECONDS * 1000
  );
  if (new Date(job.notBefore).getTime() < minimumNotBefore.getTime()) {
    fail("V2_BOOKING_BUSINESS_QUIET_PERIOD_INVALID", "copy-only job does not preserve the minimum quiet period");
  }
  if (Date.now() < new Date(job.notBefore).getTime()) {
    fail("V2_BOOKING_BUSINESS_NOT_BEFORE", "copy-only live execution is earlier than the approved not-before time");
  }
  const runRoot = isolatedD1RunRoot(job.runId);
  if (fsSync.existsSync(runRoot)) fail("V2_BOOKING_BUSINESS_RUN_EXISTS", "copy-only live run ID already exists");
  await fs.mkdir(D1_OUTPUT_ROOT, { recursive: true });
  await fs.mkdir(runRoot, { recursive: false });
  try {
    const sourceManifest = JSON.parse(await fs.readFile(SOURCE_MANIFEST_PATH, "utf8"));
    const copiedRoot = path.join(runRoot, "copied-source");
    await materializeCopy(sourceManifest, copiedRoot);
    const copied = await executeTarget({
      moduleRoot: copiedRoot,
      targetRoot: path.join(runRoot, "copied"),
      job,
      transportMode: "live",
      replayFile: "",
      jobDigest,
      expectedEnvelopeSha256: job.expectedEnvelopeSha256
    });
    const envelope = copied.projection.request?.fetchEnvelope;
    const passed = copied.projection.status === "succeeded"
      && copied.projection.classification === "resolved"
      && copied.projection.providerStatus === 200
      && copied.projection.bookingBusinessIdHash === job.expectedBookingBusinessIdHash
      && copied.projection.bookingUrlPresent === true
      && copied.projection.calls.actualExternal === 1
      && envelope?.envelopeSha256 === COPY_ONLY_EXPECTED_ENVELOPE_SHA256;
    const observation = Object.freeze({
      schemaVersion: COPY_ONLY_RESULT_SCHEMA_VERSION,
      status: passed ? "passed" : "failed",
      runId: job.runId,
      baseline,
      previousEvidence,
      runtime,
      jobApprovalDigest: jobDigest,
      notBefore: job.notBefore,
      applicationEnvelopeSha256: envelope?.envelopeSha256 || null,
      copied: copied.projection,
      originalExecuted: false,
      replayExecuted: false,
      externalRequestCount: copied.projection.calls.actualExternal,
      placeListRequests: 0,
      bookingBusinessRequests: copied.projection.calls.bookingBusiness,
      bookingItemsRequests: 0,
      dailyScheduleRequests: 0,
      htmlFallbackRequests: 0,
      historicalFallbackReads: 0,
      retries: 0,
      fallbacks: 0,
      operationalWrites: 0,
      rawProviderResponsesStored: false
    });
    await atomicJson(path.join(runRoot, "copy-only-observation.json"), observation);
    if (!passed) fail("V2_BOOKING_BUSINESS_COPY_ONLY_LIVE_MISMATCH", "copy-only live result did not match the frozen identity contract");
    return observation;
  } catch (error) {
    await atomicJson(path.join(runRoot, "failure.json"), {
      schemaVersion: "v2-booking-business-d1-failure.v1",
      code: String(error?.code || "V2_BOOKING_BUSINESS_COPY_ONLY_LIVE_FAILED"),
      retryable: false
    }).catch(() => {});
    throw error;
  }
}

async function runSingleFixture(job, scenario, root) {
  const normalized = normalizeJob({ ...job, fixtureScenario: scenario });
  await fs.mkdir(root, { recursive: false });
  return executeTarget({
    moduleRoot: ROOT,
    targetRoot: path.join(root, "target"),
    job: normalized,
    transportMode: "fixture",
    replayFile: "",
    jobDigest: sha256(stableJson(normalized))
  });
}

async function main(argv = process.argv.slice(2)) {
  const [command, jobFlag, jobPath] = argv;
  const commands = new Set([
    "validate",
    "offline-pair",
    "live-pair",
    "validate-copy-only",
    "envelope-parity",
    "copy-only-live"
  ]);
  if (jobFlag !== "--job" || !jobPath || !commands.has(command)) {
    fail("V2_BOOKING_BUSINESS_COMMAND_INVALID", "usage: validate|offline-pair|validate-copy-only|envelope-parity|copy-only-live --job <path>");
  }
  if (["validate-copy-only", "envelope-parity", "copy-only-live"].includes(command)) {
    if (command === "envelope-parity") {
      process.stdout.write(`${JSON.stringify(await runEnvelopeParity(jobPath))}\n`);
      return;
    }
    if (command === "copy-only-live") {
      process.stdout.write(`${JSON.stringify(await runCopyOnlyLive(jobPath))}\n`);
      return;
    }
    const [{ job, digest }, baseline, previousEvidence] = await Promise.all([
      readCopyOnlyJob(jobPath),
      verifyBaseline(),
      verifyPreviousLiveEvidence()
    ]);
    const runtime = verifyRuntime();
    if (digest !== COPY_ONLY_APPROVED_JOB_SHA256 || job.expectedEnvelopeSha256 !== COPY_ONLY_EXPECTED_ENVELOPE_SHA256) {
      fail("V2_BOOKING_BUSINESS_COPY_ONLY_JOB_MISMATCH", "copy-only job identity is not frozen in code");
    }
    process.stdout.write(`${JSON.stringify({ status: "validated", runId: job.runId, mode: job.mode, jobApprovalDigest: digest, baseline, previousEvidence, runtime })}\n`);
    return;
  }
  const { job, digest } = await readJob(jobPath);
  if (command === "validate") {
    const baseline = await verifyBaseline();
    process.stdout.write(`${JSON.stringify({ status: "validated", runId: job.runId, mode: job.mode, jobApprovalDigest: digest, baseline })}\n`);
    return;
  }
  if (command === "offline-pair" && job.mode !== "offline") fail("V2_BOOKING_BUSINESS_COMMAND_INVALID", "job mode is not offline");
  if (command === "live-pair") fail("V2_BOOKING_BUSINESS_PAIR_LIVE_CLOSED", "the original-plus-copy live pair is permanently disabled after N3-Live");
  const result = await runPair(jobPath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "v2-booking-business-harness-error.v1",
      status: "failed",
      code: String(error?.code || "V2_BOOKING_BUSINESS_HARNESS_FAILED"),
      retryable: false
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ALLOWED_FIXTURE_SCENARIOS,
  BASELINE_COMMIT,
  BASELINE_PROTECTED_TREE_ENTRY_COUNT,
  BASELINE_PROTECTED_TREE_SHA256,
  COLLECTOR_BLOB,
  COPY_ONLY_APPROVED_JOB_SHA256,
  COPY_ONLY_EXPECTED_ENVELOPE_SHA256,
  COPY_ONLY_JOB_SCHEMA_VERSION,
  COPY_ONLY_MINIMUM_QUIET_SECONDS,
  D1_OUTPUT_ROOT,
  EXPECTED_BOOKING_BUSINESS_ID_HASH,
  JOB_SCHEMA_VERSION,
  LIVE_PLACE_ID_HASH,
  LOCKFILE_SHA256,
  SHALLOW_EXPECTED_PARENT_COMMIT,
  SHALLOW_EXPECTED_HEAD_SOURCE_PATHS,
  OUTPUT_ROOT,
  PHASE2_LIVE_PAIR_SHA256,
  compareTargets,
  isolatedD1RunRoot,
  isolatedRunRoot,
  normalizeCopyOnlyJob,
  normalizeJob,
  readCopyOnlyJob,
  readJob,
  runCopyOnlyLive,
  runEnvelopeParity,
  runPair,
  runSingleFixture,
  canonicalGitTextBytes,
  gitBlobFromBytes,
  manifestRecordedTextBytes,
  sha256,
  stableJson,
  verifyManifestFileBytes,
  verifyBaseline,
  verifyCommitLineage,
  protectedTreeSnapshot,
  verifyPreviousLiveEvidence,
  verifyRuntime
};
