"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const BASELINE_COMMIT = "b5de9c40199f40a4409f93b1b66f0b9ccea17a83";
const BASELINE_COLLECTOR_BLOB = "c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3";
const REFERENCE_COLLECTOR_COMMIT = "4e4e1906e2967fe58df66f8ad67f832043d2763b";
const REFERENCE_COLLECTOR_BLOB = "bcbe229998da3afa6f31ee04375fb0766019e56f";
const LOCKFILE_SHA256 = "ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2";
const MANIFEST_PATH = path.join(ROOT, "docs", "v2_native_main_place_source_manifest.json");
const OUTPUT_ROOT = path.join(ROOT, "outputs", "rebuild-phase1");
const NETWORK_PRELOAD = path.join(__dirname, "fixture_network_guard_preload.cjs");
const FIXTURE_PRELOAD = path.join(__dirname, "naver_legacy_inventory_fixture_preload.cjs");
const CAPTURE_PRELOAD = path.join(__dirname, "v2_native_main_place_preload.cjs");
const SOURCE_ROOTS = Object.freeze([
  "scripts/collection_worker_v2_top20_collector.cjs",
  "scripts/gyeongnam_glamping_crawl.cjs"
]);

class V2NativeMainPlaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "V2NativeMainPlaceError";
    this.code = code;
    this.retryable = false;
  }
}

function harnessError(code, message) {
  return new V2NativeMainPlaceError(code, message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value))).digest("hex");
}

function trackedGitBlob(relative) {
  return execFileSync("git", ["hash-object", `--path=${relative}`, relative], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true
  }).trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function posixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function currentHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
}

async function resolveLocalModule(fromFile, request) {
  const base = path.resolve(path.dirname(fromFile), request);
  const candidates = [base, `${base}.cjs`, `${base}.js`, `${base}.json`, path.join(base, "index.cjs"), path.join(base, "index.js")];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Continue through the deterministic candidate list.
    }
  }
  throw harnessError("V2_NATIVE_SOURCE_CLOSURE_INVALID", `local dependency cannot be resolved: ${request}`);
}

async function dependencyClosure() {
  const pending = SOURCE_ROOTS.map((filePath) => path.join(ROOT, filePath));
  const visited = new Set();
  while (pending.length) {
    const absolute = path.resolve(pending.pop());
    const relative = posixPath(path.relative(ROOT, absolute));
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
      throw harnessError("V2_NATIVE_SOURCE_CLOSURE_INVALID", "source dependency escaped the repository root");
    }
    if (visited.has(relative)) continue;
    visited.add(relative);
    if (!/\.(?:cjs|js)$/u.test(absolute)) continue;
    const source = await fs.readFile(absolute, "utf8");
    const pattern = /require\(\s*(["'])(\.\.?\/[^"']+)\1\s*\)/gu;
    for (const match of source.matchAll(pattern)) pending.push(await resolveLocalModule(absolute, match[2]));
  }
  visited.add("package.json");
  visited.add("package-lock.json");
  return [...visited].sort();
}

async function buildSourceManifest() {
  if (currentHead() !== BASELINE_COMMIT) {
    throw harnessError("V2_NATIVE_BASELINE_MISMATCH", "HEAD does not match the verified V2 baseline commit");
  }
  const files = [];
  for (const relative of await dependencyClosure()) {
    const content = await fs.readFile(path.join(ROOT, relative));
    files.push({ path: relative, bytes: content.length, sha256: sha256(content), gitBlob: trackedGitBlob(relative) });
  }
  const collector = files.find((entry) => entry.path === "scripts/gyeongnam_glamping_crawl.cjs");
  const lockfile = files.find((entry) => entry.path === "package-lock.json");
  if (collector?.gitBlob !== BASELINE_COLLECTOR_BLOB || lockfile?.sha256 !== LOCKFILE_SHA256) {
    throw harnessError("V2_NATIVE_BASELINE_MISMATCH", "collector or lockfile hash does not match the verified baseline");
  }
  return {
    schemaVersion: "v2-native-main-place-source-manifest.v1",
    baselineCommit: BASELINE_COMMIT,
    baselineCollectorBlob: BASELINE_COLLECTOR_BLOB,
    referenceCollector: { commit: REFERENCE_COLLECTOR_COMMIT, blob: REFERENCE_COLLECTOR_BLOB },
    lockfileSha256: LOCKFILE_SHA256,
    nodeVersion: "26.5.0",
    roots: SOURCE_ROOTS,
    externalDependencies: [{ name: "write-excel-file", version: "4.1.1", mainPlaceProbeDisposition: "unreachable-and-fail-closed" }],
    files
  };
}

async function writeSourceManifest() {
  const manifest = await buildSourceManifest();
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

async function readAndVerifySourceManifest() {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
  } catch {
    throw harnessError("V2_NATIVE_SOURCE_MANIFEST_MISSING", "source manifest must be generated and reviewed first");
  }
  const expected = await buildSourceManifest();
  if (stableJson(manifest) !== stableJson(expected)) {
    throw harnessError("V2_NATIVE_SOURCE_MANIFEST_MISMATCH", "source manifest does not match the verified dependency closure");
  }
  return Object.freeze({ manifest, digest: sha256(stableJson(manifest)) });
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw harnessError("V2_NATIVE_JOB_INVALID", `${label} is invalid`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw harnessError("V2_NATIVE_JOB_INVALID", `${label} fields are invalid`);
  }
}

function canonicalDate(value, label) {
  const text = String(value || "");
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw harnessError("V2_NATIVE_JOB_INVALID", `${label} is invalid`);
  }
  return text;
}

function normalizeJob(value) {
  exactKeys(value, ["schemaVersion", "runId", "mode", "keyword", "checkIn", "checkOut", "timeoutMs"], "job");
  const rawKeyword = String(value.keyword || "");
  const keyword = rawKeyword.normalize("NFC").trim().replace(/\s+/gu, " ");
  const checkIn = canonicalDate(value.checkIn, "checkIn");
  const checkOut = canonicalDate(value.checkOut, "checkOut");
  if (
    value.schemaVersion !== "v2-native-main-place-job.v1"
    || !/^[a-z0-9][a-z0-9._-]{7,79}$/u.test(String(value.runId || ""))
    || !["offline", "live"].includes(value.mode)
    || !keyword
    || keyword.length > 120
    || /[\r\n\0]/u.test(rawKeyword)
    || checkIn !== checkOut
    || !Number.isInteger(value.timeoutMs)
    || value.timeoutMs < 5_000
    || value.timeoutMs > 25_000
  ) throw harnessError("V2_NATIVE_JOB_INVALID", "job does not match the bounded main-place contract");
  return Object.freeze({ ...value, keyword, checkIn, checkOut });
}

function buildContract(job) {
  return Object.freeze({
    keyword: job.keyword,
    searchMode: "keyword",
    collectionMode: "precision",
    collectionPurpose: "revenue_detail",
    productMode: "all",
    checkIn: job.checkIn,
    checkOut: job.checkOut,
    bookingRangeDays: 1,
    rankStart: 1,
    rankEnd: 50,
    detailRankStart: 1,
    detailRankEnd: 20
  });
}

function jobApprovalDigest(job) {
  return sha256(stableJson(job));
}

function assertLiveApproval(job) {
  if (
    process.env.V2_NATIVE_MAIN_PLACE_LIVE_APPROVED !== "N1-Live"
    || process.env.V2_NATIVE_MAIN_PLACE_LIVE_PAIR_BUDGET !== "2"
    || process.env.V2_NATIVE_MAIN_PLACE_APPROVED_JOB_SHA256 !== jobApprovalDigest(job)
  ) throw harnessError("V2_NATIVE_LIVE_APPROVAL_REQUIRED", "Approval N1-Live, the exact job digest, and the two-call pair budget are required");
}

function assertEvidenceRoot(evidenceRoot, allowTestRoot) {
  const resolved = path.resolve(evidenceRoot);
  const allowed = path.resolve(OUTPUT_ROOT);
  if (allowTestRoot === true && process.env.NODE_ENV === "test") return resolved;
  const relative = path.relative(allowed, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw harnessError("V2_NATIVE_OUTPUT_PATH_INVALID", "evidence root must stay inside the local rebuild output root");
  }
  return resolved;
}

async function materializeCopy(manifest, snapshotRoot) {
  for (const entry of manifest.files) {
    const source = path.join(ROOT, entry.path);
    const target = path.join(snapshotRoot, entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    const copied = await fs.readFile(target);
    if (sha256(copied) !== entry.sha256) {
      throw harnessError("V2_NATIVE_COPY_HASH_MISMATCH", `copied source hash mismatch: ${entry.path}`);
    }
  }
}

function preloadOptions(paths) {
  return paths.map((filePath) => `--require=${filePath}`).join(" ");
}

function spawnWithEnvironment(injected) {
  return (command, args, options) => spawn(command, args, {
    ...options,
    env: { ...options.env, ...injected },
    windowsHide: true
  });
}

async function runTarget({ job, target, moduleRoot, targetRoot }) {
  const offline = job.mode === "offline";
  await fs.mkdir(targetRoot, { recursive: false });
  const preloads = offline
    ? [NETWORK_PRELOAD, FIXTURE_PRELOAD, CAPTURE_PRELOAD]
    : [CAPTURE_PRELOAD];
  const auditFile = path.join(targetRoot, "provider-audit.json");
  const injected = {
    NODE_OPTIONS: preloadOptions(preloads),
    V2_NATIVE_CAPTURE_ROOT: targetRoot
  };
  if (offline) {
    Object.assign(injected, {
      NAVER_INVENTORY_FIXTURE_ROOT: targetRoot,
      NAVER_INVENTORY_FIXTURE_MODE: "success",
      NAVER_INVENTORY_FIXTURE_AUDIT_FILE: auditFile,
      SEARCH_INTENT: "",
      SEARCH_INTENT_CONFIDENCE: "0"
    });
  }
  const collector = require(path.join(moduleRoot, "scripts", "collection_worker_v2_top20_collector.cjs"));
  let authorizeCount = 0;
  let startedCount = 0;
  const result = await collector.executeV2Top20MainPlaceRecoveryProbe({
    contract: buildContract(job),
    cwd: moduleRoot,
    scriptPath: path.join(moduleRoot, "scripts", "gyeongnam_glamping_crawl.cjs"),
    tempBase: targetRoot,
    maxRuntimeMs: job.timeoutMs,
    baseEnvironment: { ...process.env, NODE_ENV: offline ? "test" : "production" },
    spawnImpl: spawnWithEnvironment(injected),
    heartbeat: async () => {},
    onProviderAuthorize: async (metadata) => {
      if (metadata.operation !== "main_place" || metadata.requestOrdinal !== 1) {
        throw harnessError("V2_NATIVE_CALL_SEQUENCE_INVALID", "provider authorization escaped the one-call plan");
      }
      authorizeCount += 1;
    },
    onProviderCall: async (metadata) => {
      if (metadata.operation !== "main_place" || metadata.requestOrdinal !== 1) {
        throw harnessError("V2_NATIVE_CALL_SEQUENCE_INVALID", "provider execution escaped the one-call plan");
      }
      startedCount += 1;
    }
  });
  if (authorizeCount !== 1 || startedCount !== 1 || result.providerCallCount !== 1) {
    throw harnessError("V2_NATIVE_CALL_SEQUENCE_INVALID", "main-place probe did not execute exactly once");
  }
  const capture = JSON.parse(await fs.readFile(path.join(targetRoot, "sanitized-capture.json"), "utf8"));
  let fixtureAudit = null;
  if (offline) {
    fixtureAudit = JSON.parse(await fs.readFile(auditFile, "utf8"));
    if (fixtureAudit.callCount !== 1 || fixtureAudit.operationCounts?.main_place !== 1) {
      throw harnessError("V2_NATIVE_FIXTURE_SEQUENCE_INVALID", "offline fixture did not observe exactly one main-place operation");
    }
  }
  return Object.freeze({
    target,
    result,
    capture,
    captureDigest: sha256(stableJson(capture)),
    providerCallCount: 1,
    actualExternalRequestCount: offline ? 0 : 1,
    fixtureAudit: fixtureAudit ? { callCount: 1, operationCounts: { main_place: 1 } } : null
  });
}

function replaySanitizedCapture(capture, copiedRoot) {
  const { createApolloFixture } = require(path.join(ROOT, "scripts", "naver_collector_fixture_factory.cjs"));
  const { selectNaverOrganicResult } = require(path.join(copiedRoot, "scripts", "naver_place_apollo_parser.cjs"));
  const query = "v2 native sanitized replay";
  const items = capture.organic.items.map((entry) => ({
    id: entry.placeId,
    name: entry.fields.name ? `Replay ${entry.rank}` : "",
    category: entry.fields.category ? "Replay category" : "",
    roadAddress: entry.fields.address ? `Replay road ${entry.rank}` : "",
    placeReviewCount: entry.fields.placeReviewCount ? entry.rank : undefined,
    placeReviewScore: entry.fields.placeReviewScore ? 4.5 : undefined,
    hasBooking: entry.fields.hasBooking ? true : undefined
  }));
  const selected = selectNaverOrganicResult(createApolloFixture({ query, display: 50, total: capture.organic.total, items }).state, query);
  const replayIds = selected.items.map((item) => String(item.id || item.placeId || ""));
  const expectedIds = capture.organic.items.map((item) => item.placeId);
  const replayFields = selected.items.map((item) => ({
    name: typeof item?.name === "string" && item.name.length > 0,
    category: typeof item?.category === "string" && item.category.length > 0,
    address: [item?.roadAddress, item?.jibunAddress, item?.address, item?.commonAddress]
      .some((value) => typeof value === "string" && value.length > 0),
    placeReviewCount: Number.isFinite(Number(item?.placeReviewCount)),
    placeReviewScore: Number.isFinite(Number(item?.placeReviewScore)),
    hasBooking: typeof item?.hasBooking === "boolean"
  }));
  const expectedFields = capture.organic.items.map((item) => item.fields);
  const stableIdsMatched = stableJson(replayIds) === stableJson(expectedIds);
  const fieldPresenceMatched = stableJson(replayFields) === stableJson(expectedFields);
  return Object.freeze({
    schemaVersion: "v2-native-main-place-sanitized-replay.v1",
    matched: stableIdsMatched && fieldPresenceMatched,
    itemCount: replayIds.length,
    stableIdsMatched,
    fieldPresenceMatched,
    rawProviderResponseUsed: false
  });
}

function comparePair(original, copied, replay, mode) {
  const resultShape = (value) => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item]));
  const captureShape = (value) => ({
    schemaVersion: value.schemaVersion,
    parseStatus: value.parseStatus,
    requestKeys: Object.keys(value.request).sort(),
    responseKeys: Object.keys(value.response).sort(),
    organicKeys: Object.keys(value.organic).sort(),
    itemFieldKeys: Object.keys(value.organic?.items?.[0]?.fields || {}).sort()
  });
  const structural = stableJson(resultShape(original.result)) === stableJson(resultShape(copied.result))
    && stableJson(captureShape(original.capture)) === stableJson(captureShape(copied.capture));
  const exact = stableJson(original.result) === stableJson(copied.result)
    && original.captureDigest === copied.captureDigest;
  const originalById = new Map(original.capture.organic.items.map((item) => [item.placeId, item]));
  const copiedById = new Map(copied.capture.organic.items.map((item) => [item.placeId, item]));
  const sharedIds = [...originalById.keys()].filter((placeId) => copiedById.has(placeId));
  const rankChanges = sharedIds.filter((placeId) => originalById.get(placeId).rank !== copiedById.get(placeId).rank).length;
  const fieldPresenceChanges = sharedIds.filter((placeId) => (
    stableJson(originalById.get(placeId).fields) !== stableJson(copiedById.get(placeId).fields)
  )).length;
  const liveObservation = {
    originalStableIdCount: originalById.size,
    copiedStableIdCount: copiedById.size,
    sharedStableIdCount: sharedIds.length,
    originalOnlyStableIdCount: originalById.size - sharedIds.length,
    copiedOnlyStableIdCount: copiedById.size - sharedIds.length,
    sharedStableIdDigest: sha256(stableJson(sharedIds.sort())),
    rankChangeCount: rankChanges,
    fieldPresenceChangeCount: fieldPresenceChanges,
    responseStatusPair: [original.capture.response.status, copied.capture.response.status],
    adCountPair: [original.result.adCount, copied.result.adCount]
  };
  return Object.freeze({
    schemaVersion: "v2-native-main-place-comparison.v1",
    structuralParity: structural,
    exactParity: mode === "offline" ? exact : null,
    sanitizedReplayParity: replay.matched,
    liveObservation: mode === "live" ? liveObservation : null,
    dynamicDifferences: mode === "live" && !exact
      ? {
          organicCount: [original.result.organicCount, copied.result.organicCount],
          observedRankCount: [original.result.observedRankCount, copied.result.observedRankCount],
          adCount: [original.result.adCount, copied.result.adCount]
        }
      : null
  });
}

async function writeAtomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await fs.rename(temporary, filePath);
}

async function runPair(inputJob, options = {}) {
  const job = normalizeJob(inputJob);
  if (job.mode === "live") assertLiveApproval(job);
  const { manifest, digest } = await readAndVerifySourceManifest();
  const evidenceRoot = assertEvidenceRoot(options.evidenceRoot || OUTPUT_ROOT, options.allowTestRoot);
  const runRoot = path.join(evidenceRoot, job.runId);
  await fs.mkdir(evidenceRoot, { recursive: true });
  try {
    await fs.mkdir(runRoot, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") throw harnessError("V2_NATIVE_RUN_ALREADY_EXISTS", "run ID already has evidence; overwrite is forbidden");
    throw error;
  }
  const snapshotRoot = path.join(runRoot, "copied-source");
  await materializeCopy(manifest, snapshotRoot);
  const original = await runTarget({ job, target: "original", moduleRoot: ROOT, targetRoot: path.join(runRoot, "original") });
  const replay = replaySanitizedCapture(original.capture, snapshotRoot);
  if (!replay.matched) throw harnessError("V2_NATIVE_SANITIZED_REPLAY_MISMATCH", "copied parser did not reproduce sanitized stable IDs");
  const copied = await runTarget({ job, target: "copy", moduleRoot: snapshotRoot, targetRoot: path.join(runRoot, "copy") });
  const comparison = comparePair(original, copied, replay, job.mode);
  if (!comparison.structuralParity || (job.mode === "offline" && !comparison.exactParity)) {
    throw harnessError("V2_NATIVE_STRUCTURAL_PARITY_MISMATCH", "original and copied main-place paths are not structurally equivalent");
  }
  const output = {
    schemaVersion: "v2-native-main-place-pair-result.v1",
    runId: job.runId,
    mode: job.mode,
    baselineCommit: BASELINE_COMMIT,
    baselineCollectorBlob: BASELINE_COLLECTOR_BLOB,
    sourceManifestDigest: digest,
    keywordHash: sha256(job.keyword),
    period: { checkIn: job.checkIn, checkOut: job.checkOut },
    requestContract: {
      method: "GET",
      origin: "https://pcmap.place.naver.com",
      path: "/accommodation/list",
      queryParameterNames: ["query"],
      maximumExternalRequests: job.mode === "live" ? 2 : 0,
      timeoutMs: job.timeoutMs,
      retries: 0,
      fallbacks: 0
    },
    original,
    copied,
    replay,
    comparison,
    actualExternalRequestCount: original.actualExternalRequestCount + copied.actualExternalRequestCount,
    automaticRetries: 0,
    automaticFallbacks: 0,
    operationalWrites: 0,
    rawProviderResponsesStored: false
  };
  await writeAtomicJson(path.join(runRoot, "pair-result.json"), output);
  return Object.freeze(output);
}

async function readJob(filePath) {
  const resolved = path.resolve(filePath);
  return normalizeJob(JSON.parse(await fs.readFile(resolved, "utf8")));
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!command || !["manifest", "validate", "offline-pair", "live-pair"].includes(command)) {
    throw harnessError("V2_NATIVE_COMMAND_INVALID", "command must be manifest, validate, offline-pair, or live-pair");
  }
  if (command === "manifest") {
    if (rest.length) throw harnessError("V2_NATIVE_COMMAND_INVALID", "manifest takes no arguments");
    return { command };
  }
  if (rest.length !== 2 || rest[0] !== "--job" || !rest[1]) {
    throw harnessError("V2_NATIVE_COMMAND_INVALID", "command requires exactly --job <file>");
  }
  return { command, jobFile: rest[1] };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.command === "manifest") {
    const manifest = await writeSourceManifest();
    return { status: "manifest_written", fileCount: manifest.files.length, collectorBlob: manifest.baselineCollectorBlob };
  }
  const job = await readJob(cli.jobFile);
  if (cli.command === "validate") {
    const verified = await readAndVerifySourceManifest();
    return {
      status: "validated",
      mode: job.mode,
      runId: job.runId,
      jobApprovalDigest: jobApprovalDigest(job),
      sourceManifestDigest: verified.digest
    };
  }
  if (cli.command === "offline-pair" && job.mode !== "offline") throw harnessError("V2_NATIVE_JOB_MODE_INVALID", "offline-pair requires an offline job");
  if (cli.command === "live-pair" && job.mode !== "live") throw harnessError("V2_NATIVE_JOB_MODE_INVALID", "live-pair requires a live job");
  return runPair(job);
}

if (require.main === module) {
  main().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "v2-native-main-place-error.v1",
      status: "failed",
      code: String(error?.code || "V2_NATIVE_MAIN_PLACE_FAILED"),
      retryable: false
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BASELINE_COLLECTOR_BLOB,
  BASELINE_COMMIT,
  LOCKFILE_SHA256,
  MANIFEST_PATH,
  OUTPUT_ROOT,
  V2NativeMainPlaceError,
  buildSourceManifest,
  jobApprovalDigest,
  normalizeJob,
  readAndVerifySourceManifest,
  replaySanitizedCapture,
  runPair,
  stableJson,
  writeSourceManifest
};
