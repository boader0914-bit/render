"use strict";

const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { createRequire } = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const BASELINE_COMMIT = "8adbb1d10ba0c137130662813ce0f3b2ccca4841";
const SOURCE_BASELINE_COMMIT = "b5de9c40199f40a4409f93b1b66f0b9ccea17a83";
const COLLECTOR_BLOB = "c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3";
const LOCKFILE_SHA256 = "ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2";
const SOURCE_MANIFEST_DIGEST = "89ed646cc3ad57bb38da577cd177d6827aeb3f008553b2c1c8a8df242e642b40";
const PHASE1_LIVE_JOB_DIGEST = "9003421b3b7697f38906486ac4d05846fa3f0fc4b4bfb1a6267973906fa7b6e4";
const PHASE1_LIVE_PAIR_SHA256 = "a6e3b070dcaec15b6ecde8c736fa6b57d53c4468a49b01f1f28e53e637a7db93";
const PHASE1_REPORT_SHA256 = "0ca2e150323623a0e6bf4bba0e694dd44c788064b4541895e6107520470dd016";
const SOURCE_MANIFEST_PATH = path.join(ROOT, "docs", "v2_native_main_place_source_manifest.json");
const PHASE1_REPORT_PATH = path.join(ROOT, "docs", "datalab_rebuild_phase1_report.md");
const OUTPUT_ROOT = path.join(ROOT, "outputs", "rebuild-phase2");
const COLLECTOR_RELATIVE = "scripts/gyeongnam_glamping_crawl.cjs";
const NETWORK_PRELOAD = path.join(ROOT, "scripts", "fixture_network_guard_preload.cjs");
const ARTIFACT_PRELOAD = path.join(ROOT, "scripts", "v2_place_artifact_preload.cjs");
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ALLOWED_SCENARIOS = Object.freeze([
  "success",
  "no_ads",
  "empty",
  "duplicates",
  "missing_fields",
  "limit",
  "partial_artifact_failure"
]);

class V2PlaceArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "V2PlaceArtifactError";
    this.code = code;
    this.retryable = false;
  }
}

function fail(code, message) {
  throw new V2PlaceArtifactError(code, message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value))).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function currentHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
}

function gitBlob(relative) {
  return execFileSync("git", ["hash-object", `--path=${relative}`, relative], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true
  }).trim();
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("V2_PLACE_ARTIFACT_JOB_INVALID", `${label} is invalid`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("V2_PLACE_ARTIFACT_JOB_INVALID", `${label} fields are invalid`);
  }
}

function canonicalDate(value, label) {
  const text = String(value || "");
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    fail("V2_PLACE_ARTIFACT_JOB_INVALID", `${label} is invalid`);
  }
  return text;
}

function normalizeJob(value) {
  exactKeys(value, [
    "schemaVersion", "runId", "mode", "keyword", "checkIn", "checkOut", "timeoutMs",
    "responseSizeLimitBytes", "fixtureScenario"
  ], "job");
  const rawKeyword = String(value.keyword || "");
  const keyword = rawKeyword.normalize("NFC").trim().replace(/\s+/gu, " ");
  const checkIn = canonicalDate(value.checkIn, "checkIn");
  const checkOut = canonicalDate(value.checkOut, "checkOut");
  const fixtureScenario = String(value.fixtureScenario || "");
  if (
    value.schemaVersion !== "v2-place-artifact-job.v1"
    || !/^[a-z0-9][a-z0-9._-]{7,79}$/u.test(String(value.runId || ""))
    || !new Set(["offline", "live"]).has(value.mode)
    || !keyword
    || keyword.length > 120
    || /[\r\n\0]/u.test(rawKeyword)
    || checkIn !== checkOut
    || !Number.isInteger(value.timeoutMs)
    || value.timeoutMs < 5_000
    || value.timeoutMs > 25_000
    || value.responseSizeLimitBytes !== MAX_RESPONSE_BYTES
    || (value.mode === "offline" && !ALLOWED_SCENARIOS.includes(fixtureScenario))
    || (value.mode === "live" && fixtureScenario !== "none")
  ) fail("V2_PLACE_ARTIFACT_JOB_INVALID", "job does not match the bounded Place artifact contract");
  return Object.freeze({ ...value, keyword, checkIn, checkOut, fixtureScenario });
}

function jobApprovalDigest(job) {
  return sha256(stableJson(normalizeJob(job)));
}

async function readJob(filePath) {
  return normalizeJob(JSON.parse(await fs.readFile(path.resolve(filePath), "utf8")));
}

async function verifyBaseline() {
  const head = currentHead();
  if (head !== BASELINE_COMMIT) fail("V2_PLACE_ARTIFACT_BASELINE_MISMATCH", "HEAD does not match the Phase 1 baseline commit");
  const sourceManifestBytes = await fs.readFile(SOURCE_MANIFEST_PATH);
  const sourceManifest = JSON.parse(sourceManifestBytes.toString("utf8"));
  const sourceManifestDigest = sha256(stableJson(sourceManifest));
  if (sourceManifestDigest !== SOURCE_MANIFEST_DIGEST || sourceManifest.files?.length !== 20) {
    fail("V2_PLACE_ARTIFACT_SOURCE_MANIFEST_MISMATCH", "source manifest digest or file count changed");
  }
  if (sourceManifest.baselineCommit !== SOURCE_BASELINE_COMMIT || sourceManifest.baselineCollectorBlob !== COLLECTOR_BLOB) {
    fail("V2_PLACE_ARTIFACT_SOURCE_MANIFEST_MISMATCH", "source manifest identity changed");
  }
  const sourceFiles = [];
  for (const entry of sourceManifest.files) {
    const content = await fs.readFile(path.join(ROOT, entry.path));
    const observed = { path: entry.path, bytes: content.length, sha256: sha256(content), gitBlob: gitBlob(entry.path) };
    if (observed.bytes !== entry.bytes || observed.sha256 !== entry.sha256 || observed.gitBlob !== entry.gitBlob) {
      fail("V2_PLACE_ARTIFACT_SOURCE_FILE_MISMATCH", `baseline source changed: ${entry.path}`);
    }
    sourceFiles.push(observed);
  }
  const changed = execFileSync("git", ["diff", "--name-only", BASELINE_COMMIT, "--", ...sourceManifest.files.map((entry) => entry.path)], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true
  }).trim();
  if (changed) fail("V2_PLACE_ARTIFACT_SOURCE_FILE_MISMATCH", "one or more baseline source files have a diff");
  if (gitBlob(COLLECTOR_RELATIVE) !== COLLECTOR_BLOB) fail("V2_PLACE_ARTIFACT_COLLECTOR_MISMATCH", "collector blob changed");
  const lockfileSha256 = sha256(await fs.readFile(path.join(ROOT, "package-lock.json")));
  if (lockfileSha256 !== LOCKFILE_SHA256) fail("V2_PLACE_ARTIFACT_LOCKFILE_MISMATCH", "package-lock changed");
  const phase1ReportSha256 = sha256(await fs.readFile(PHASE1_REPORT_PATH));
  if (phase1ReportSha256 !== PHASE1_REPORT_SHA256) fail("V2_PLACE_ARTIFACT_PHASE1_EVIDENCE_MISMATCH", "Phase 1 report changed");

  const phase1Candidates = [
    path.join(ROOT, "outputs", "rebuild-phase1", "rebuild-phase1-main-place-live-001", "pair-result.json"),
    path.join(path.dirname(ROOT), "v2-native-collector-baseline", "outputs", "rebuild-phase1", "rebuild-phase1-main-place-live-001", "pair-result.json")
  ];
  let phase1LivePairPath = null;
  for (const candidate of phase1Candidates) {
    try {
      if (sha256(await fs.readFile(candidate)) === PHASE1_LIVE_PAIR_SHA256) {
        phase1LivePairPath = candidate;
        break;
      }
    } catch {
      // Phase 1 ignored evidence can legitimately be absent in a fresh checkout.
    }
  }
  return Object.freeze({
    head,
    collectorBlob: COLLECTOR_BLOB,
    lockfileSha256,
    sourceManifestDigest,
    sourceFileCount: sourceFiles.length,
    sourceBaselineCommit: SOURCE_BASELINE_COMMIT,
    phase1ReportSha256,
    phase1LiveJobDigest: PHASE1_LIVE_JOB_DIGEST,
    phase1LivePairSha256: phase1LivePairPath ? PHASE1_LIVE_PAIR_SHA256 : null,
    phase1LiveEvidencePresent: Boolean(phase1LivePairPath)
  });
}

function workbookDependencyStatus() {
  const packageJsonPath = path.join(ROOT, "node_modules", "write-excel-file", "package.json");
  try {
    const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, "utf8"));
    const requireFromRoot = createRequire(path.join(ROOT, "package.json"));
    requireFromRoot.resolve("write-excel-file/node");
    requireFromRoot.resolve("fflate");
    return Object.freeze({ installed: packageJson.version === "4.1.1", version: packageJson.version, packageJsonPath });
  } catch {
    return Object.freeze({ installed: false, version: null, packageJsonPath: null });
  }
}

function assertLiveApproval(job, dependency) {
  if (
    process.env.V2_PLACE_ARTIFACT_LIVE_APPROVED !== "N2-Live"
    || process.env.V2_PLACE_ARTIFACT_LIVE_PAIR_BUDGET !== "2"
    || process.env.V2_PLACE_ARTIFACT_APPROVED_JOB_SHA256 !== jobApprovalDigest(job)
  ) fail("V2_PLACE_ARTIFACT_LIVE_APPROVAL_REQUIRED", "Approval N2-Live and the exact job digest are required");
  if (!dependency.installed) {
    fail("V2_PLACE_ARTIFACT_DEPENDENCY_REQUIRED", "write-excel-file@4.1.1 is required for native live XLSX evidence");
  }
}

function assertEvidenceRoot(evidenceRoot, allowTestRoot = false) {
  const resolved = path.resolve(evidenceRoot);
  if (allowTestRoot === true && process.env.NODE_ENV === "test") return resolved;
  const relative = path.relative(OUTPUT_ROOT, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("V2_PLACE_ARTIFACT_OUTPUT_PATH_INVALID", "evidence root escaped the local Phase 2 output root");
  }
  return resolved;
}

async function materializeCopy(sourceManifest, snapshotRoot) {
  for (const entry of sourceManifest.files) {
    const source = path.join(ROOT, entry.path);
    const target = path.join(snapshotRoot, entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    if (sha256(await fs.readFile(target)) !== entry.sha256) {
      fail("V2_PLACE_ARTIFACT_COPY_HASH_MISMATCH", `copied source hash mismatch: ${entry.path}`);
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

function preloadOptions(paths) {
  return paths.map((filePath) => `--require=${filePath.replace(/\\/gu, "/")}`).join(" ");
}

function stampForJob(job) {
  return `${job.checkIn.replaceAll("-", "")}_120000_${sha256(job.runId).slice(0, 8)}`;
}

function childEnvironment({ job, targetRoot, transportMode, replayFile, workbookMode, workbookFailAt }) {
  const offline = transportMode !== "live";
  const preloads = offline ? [NETWORK_PRELOAD, ARTIFACT_PRELOAD] : [ARTIFACT_PRELOAD];
  return {
    ...safeSystemEnvironment(),
    NODE_OPTIONS: preloadOptions(preloads),
    NODE_PATH: workbookMode === "native" ? path.join(ROOT, "node_modules") : "",
    NODE_ENV: offline ? "test" : "production",
    CHECK_IN: job.checkIn,
    CHECK_OUT: job.checkOut,
    SEARCH_MODE: "keyword",
    SEARCH_INTENT: "",
    SEARCH_INTENT_CONFIDENCE: "0",
    COLLECTION_MODE: "fast",
    COLLECTION_PURPOSE: "basic_db",
    DETAIL_RANK_RANGES: "",
    PRODUCT_MODE: "all",
    BOOKING_RANGE_DAYS: "1",
    BOOKING_RANGE_PLACE_LIMIT: "0",
    SOURCE_ROLE: "admin",
    COLLECTION_SOURCE: "admin_search",
    COLLECTION_SOURCE_LABEL: "V2 Place artifact contract",
    REQUESTED_COLLECTION_MODE: "fast",
    REQUESTED_COLLECTION_PURPOSE: "basic_db",
    NAVER_LEGACY_LIMITED_ACTIVATION: "1",
    NAVER_LEGACY_INVENTORY_ACTIVATION: "0",
    V2_COLLECTOR_COMPATIBILITY_ACTIVATION: "0",
    V2_TOP20_WORKER_ACTIVATION: "0",
    NAVER_MAIN_PLACE_RECOVERY_PROBE: "0",
    NAVER_BOOKING_DETAIL_RECOVERY_PROBE: "0",
    NAVER_COLLECTOR_STRATEGY: "legacy_candidate",
    NAVER_COLLECTOR_SCOPE: "main_place_only",
    NAVER_LIMITED_ACTIVATION_PROFILE: "preview-admin-keyword-fast-main-place.v1",
    NAVER_PROVIDER_CALL_BUDGET: "1",
    NAVER_INVENTORY_CALL_BUDGET: "0",
    NAVER_TOTAL_CALL_BUDGET: "1",
    NAVER_INVENTORY_PLACE_LIMIT: "0",
    NAVER_INVENTORY_ITEM_LIMIT: "0",
    NAVER_BOOKING_STOCK_LIMIT: "0",
    NAVER_BOOKING_ID_FALLBACK: "0",
    NAVER_COUPON_PAGE_FALLBACK: "0",
    NAVER_DETAIL_LIVE_CALLS_ALLOWED: "0",
    NAVER_AUTOMATIC_RETRY: "0",
    NAVER_AUTOMATIC_FALLBACK: "0",
    RUN_STAMP: stampForJob(job),
    DATA_DIR: path.join(targetRoot, "data"),
    OUTPUTS_DIR: path.join(targetRoot, "native"),
    CONFIG_DIR: path.join(targetRoot, "config"),
    V2_PLACE_ARTIFACT_ALLOWED_ROOT: targetRoot,
    V2_PLACE_ARTIFACT_PROVIDER_AUDIT_FILE: path.join(targetRoot, "audit", "provider.json"),
    V2_PLACE_ARTIFACT_WORKBOOK_AUDIT_FILE: path.join(targetRoot, "audit", "workbook.json"),
    V2_PLACE_ARTIFACT_CAPTURE_FILE: path.join(targetRoot, "audit", "sanitized-capture.json"),
    V2_PLACE_ARTIFACT_REPLAY_FILE: replayFile || "",
    V2_PLACE_ARTIFACT_TRANSPORT_MODE: transportMode,
    V2_PLACE_ARTIFACT_FIXTURE_SCENARIO: job.fixtureScenario === "none" ? "success" : job.fixtureScenario,
    V2_PLACE_ARTIFACT_WORKBOOK_MODE: workbookMode,
    V2_PLACE_ARTIFACT_WORKBOOK_FAIL_AT: String(workbookFailAt || 0)
  };
}

function runChild({ moduleRoot, job, targetRoot, transportMode, replayFile = "", workbookMode, workbookFailAt = 0 }) {
  const collector = path.join(moduleRoot, COLLECTOR_RELATIVE);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [collector, job.keyword], {
      cwd: moduleRoot,
      env: childEnvironment({ job, targetRoot, transportMode, replayFile, workbookMode, workbookFailAt }),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current, chunk) => `${current}${chunk}`.slice(-1_000_000);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, job.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout, stderr });
    });
  });
}

function parseCsv(text) {
  const source = String(text || "").replace(/^\uFEFF/u, "");
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      record.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) fail("V2_PLACE_ARTIFACT_CSV_INVALID", "CSV ended inside a quoted field");
  if (field || record.length) {
    record.push(field);
    records.push(record);
  }
  const headers = records.shift() || [];
  const rows = records.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  return Object.freeze({ headers, rows });
}

async function listFiles(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  await visit(root);
  return output.sort();
}

async function locateNativeRun(targetRoot) {
  const nativeRoot = path.join(targetRoot, "native");
  let entries = [];
  try {
    entries = await fs.readdir(nativeRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { nativeRoot, finalDirectories: [], pendingDirectories: [] };
    throw error;
  }
  return {
    nativeRoot,
    finalDirectories: entries.filter((entry) => entry.isDirectory() && !entry.name.includes(".pending-")).map((entry) => path.join(nativeRoot, entry.name)),
    pendingDirectories: entries.filter((entry) => entry.isDirectory() && entry.name.includes(".pending-")).map((entry) => path.join(nativeRoot, entry.name))
  };
}

function canonicalManifest(value) {
  const copy = JSON.parse(JSON.stringify(value));
  for (const key of ["collectionStartedAt", "collectionCompletedAt", "dataAvailableAt"]) {
    if (key in copy) copy[key] = "<dynamic-time>";
  }
  if ("outputDir" in copy) copy.outputDir = "<isolated-output>";
  return copy;
}

function canonicalReport(value) {
  return String(value).replace(/^- 수집일시: .*$/mu, "- 수집일시: <dynamic-time>");
}

function xmlDecode(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

function xmlAttributes(source) {
  const attributes = {};
  for (const match of String(source || "").matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"]*)"/gu)) {
    attributes[match[1]] = xmlDecode(match[2]);
  }
  return attributes;
}

function xmlTextNodes(source) {
  return [...String(source || "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)]
    .map((match) => xmlDecode(match[1]))
    .join("");
}

function spreadsheetColumnIndex(reference) {
  const letters = String(reference || "").match(/^[A-Z]+/u)?.[0] || "";
  if (!letters) fail("V2_PLACE_ARTIFACT_XLSX_INVALID", "XLSX cell reference is invalid");
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return value - 1;
}

function parseSharedStrings(xml) {
  return [...String(xml || "").matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gu)]
    .map((match) => xmlTextNodes(match[1]));
}

function parseWorksheet(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of String(xml || "").matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gu)) {
    const rowAttributes = xmlAttributes(rowMatch[1]);
    const rowIndex = Number(rowAttributes.r || rows.length + 1) - 1;
    const row = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      const attributes = xmlAttributes(cellMatch[1]);
      const body = cellMatch[2] || "";
      const columnIndex = spreadsheetColumnIndex(attributes.r);
      const raw = body.match(/<v>([\s\S]*?)<\/v>/u)?.[1] || "";
      let value;
      if (attributes.t === "s") value = sharedStrings[Number(raw)] ?? "";
      else if (attributes.t === "b") value = raw === "1";
      else if (attributes.t === "inlineStr") value = xmlTextNodes(body);
      else if (attributes.t === "str") value = xmlDecode(raw);
      else value = raw === "" ? "" : Number(raw);
      row[columnIndex] = value;
    }
    while (rows.length <= rowIndex) rows.push([]);
    rows[rowIndex] = row;
  }
  return rows;
}

function workbookPhysicalKind(kind) {
  if (kind === "number") return "number";
  if (kind === "boolean") return "boolean";
  return "string";
}

function canonicalWorkbookSheets(sheets) {
  return sheets.map((sheet) => ({
    name: sheet.name,
    headers: sheet.headers,
    rows: sheet.rows.map((row) => {
      const values = [...row];
      if (sheet.name === "요약" && values[0] === "수집일시") values[1] = "<dynamic-time>";
      return values;
    }),
    physicalKinds: sheet.physicalKinds
  }));
}

async function inspectNativeWorkbook(filePath, expectedCall) {
  let unzipSync;
  try {
    ({ unzipSync } = createRequire(path.join(ROOT, "package.json"))("fflate"));
  } catch {
    fail("V2_PLACE_ARTIFACT_DEPENDENCY_REQUIRED", "fflate is required to inspect native XLSX evidence");
  }
  const bytes = await fs.readFile(filePath);
  let archive;
  try {
    archive = unzipSync(bytes);
  } catch {
    fail("V2_PLACE_ARTIFACT_XLSX_INVALID", "native XLSX is not a readable ZIP archive");
  }
  const readEntry = (name) => {
    if (!archive[name]) fail("V2_PLACE_ARTIFACT_XLSX_INVALID", `native XLSX entry is missing: ${name}`);
    return Buffer.from(archive[name]).toString("utf8");
  };
  const workbookXml = readEntry("xl/workbook.xml");
  const relationshipsXml = readEntry("xl/_rels/workbook.xml.rels");
  const sharedStrings = archive["xl/sharedStrings.xml"]
    ? parseSharedStrings(Buffer.from(archive["xl/sharedStrings.xml"]).toString("utf8"))
    : [];
  const relationshipTargets = Object.fromEntries(
    [...relationshipsXml.matchAll(/<Relationship\b([^>]*?)(?:\/>|>(?:[\s\S]*?)<\/Relationship>)/gu)]
      .map((match) => xmlAttributes(match[1]))
      .filter((value) => value.Id && value.Target)
      .map((value) => [value.Id, value.Target])
  );
  const sheetDefinitions = [...workbookXml.matchAll(/<sheet\b([^>]*?)(?:\/>|>(?:[\s\S]*?)<\/sheet>)/gu)]
    .map((match) => xmlAttributes(match[1]));
  const sheets = sheetDefinitions.map((definition) => {
    const target = relationshipTargets[definition["r:id"]];
    if (!target) fail("V2_PLACE_ARTIFACT_XLSX_INVALID", "XLSX sheet relationship is missing");
    const normalizedTarget = target.startsWith("/")
      ? target.replace(/^\//u, "")
      : path.posix.normalize(path.posix.join("xl", target));
    const rows = parseWorksheet(readEntry(normalizedTarget), sharedStrings);
    const headers = (rows[0] || []).map((value) => String(value ?? ""));
    const dataRows = rows.slice(1).map((row) => headers.map((_, index) => row[index] ?? ""));
    const physicalKinds = Object.fromEntries(headers.map((header, index) => [
      header,
      [...new Set(dataRows.map((row) => typeof row[index]))].sort()
    ]));
    return { name: definition.name, headers, rows: dataRows, physicalKinds };
  });
  const expectedSheets = Array.isArray(expectedCall?.sheets) ? expectedCall.sheets : [];
  if (stableJson(sheets.map((sheet) => sheet.name)) !== stableJson(expectedSheets.map((sheet) => sheet.name))) {
    fail("V2_PLACE_ARTIFACT_XLSX_CONTRACT_MISMATCH", "native XLSX sheet order differs from the collector invocation");
  }
  for (let index = 0; index < sheets.length; index += 1) {
    const actual = sheets[index];
    const expected = expectedSheets[index];
    if (stableJson(actual.headers) !== stableJson(expected.columns) || actual.rows.length !== expected.rowCount) {
      fail("V2_PLACE_ARTIFACT_XLSX_CONTRACT_MISMATCH", `native XLSX row or column contract differs: ${actual.name}`);
    }
    const expectedPhysicalKinds = Object.fromEntries(expected.columns.map((column) => [
      column,
      [...new Set((expected.columnCellKinds[column] || []).map(workbookPhysicalKind))].sort()
    ]));
    if (stableJson(actual.physicalKinds) !== stableJson(expectedPhysicalKinds)) {
      fail("V2_PLACE_ARTIFACT_XLSX_CONTRACT_MISMATCH", `native XLSX cell types differ: ${actual.name}`);
    }
  }
  const canonicalSheets = canonicalWorkbookSheets(sheets);
  return Object.freeze({
    fileName: path.basename(filePath),
    bytes: bytes.length,
    sha256: sha256(bytes),
    semanticDigest: sha256(stableJson(canonicalSheets)),
    archiveEntryCount: Object.keys(archive).length,
    sheets: canonicalSheets
  });
}

async function inspectTarget(targetRoot, child, workbookMode) {
  const run = await locateNativeRun(targetRoot);
  const failure = {
    exitCode: child.exitCode,
    signal: child.signal,
    timedOut: child.timedOut,
    finalDirectoryCount: run.finalDirectories.length,
    pendingDirectoryCount: run.pendingDirectories.length
  };
  if (child.exitCode !== 0) return Object.freeze({ status: "failed", ...failure });
  if (run.finalDirectories.length !== 1 || run.pendingDirectories.length !== 0) {
    fail("V2_PLACE_ARTIFACT_PUBLICATION_INVALID", "successful collector publication is not singular and atomic");
  }
  const finalDirectory = run.finalDirectories[0];
  const [manifest, providerAudit, capture, workbookAudit] = await Promise.all([
    fs.readFile(path.join(finalDirectory, "manifest.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(targetRoot, "audit", "provider.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(targetRoot, "audit", "sanitized-capture.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(targetRoot, "audit", "workbook.json"), "utf8").then(JSON.parse)
  ]);
  if (
    providerAudit.callCount !== 1
    || providerAudit.operationCounts?.main_place !== 1
    || Object.values(providerAudit.forbiddenOperationCounts || {}).some((count) => count !== 0)
    || providerAudit.retries !== 0
    || providerAudit.fallbacks !== 0
    || providerAudit.rawProviderResponseStored !== false
  ) fail("V2_PLACE_ARTIFACT_PROVIDER_AUDIT_INVALID", "Provider audit escaped the one-call Place contract");
  if (capture.parseStatus !== "parsed") fail("V2_PLACE_ARTIFACT_PARSE_FAILED", "sanitized Place response could not be parsed");
  const overallPath = path.join(finalDirectory, manifest.fileRoles.overall);
  const adsPath = path.join(finalDirectory, manifest.fileRoles.ads);
  const reportPath = path.join(finalDirectory, manifest.fileRoles.report);
  const [overallText, adsText, reportText] = await Promise.all([
    fs.readFile(overallPath, "utf8"),
    fs.readFile(adsPath, "utf8"),
    fs.readFile(reportPath, "utf8")
  ]);
  const overall = parseCsv(overallText);
  const ads = parseCsv(adsText);
  const nativeFiles = await listFiles(finalDirectory);
  const missingManifestFiles = (manifest.files || []).filter((file) => !nativeFiles.includes(file));
  const nativeWorkbooks = workbookMode === "native"
    ? await Promise.all(workbookAudit.calls.map((call) => inspectNativeWorkbook(path.join(finalDirectory, call.fileName), call)))
    : [];
  const roleContents = {};
  for (const [role, file] of Object.entries(manifest.fileRoles || {})) {
    if (file.endsWith(".csv")) roleContents[role] = await fs.readFile(path.join(finalDirectory, file), "utf8");
  }
  const canonicalContract = {
    roleContents,
    report: canonicalReport(reportText),
    manifest: canonicalManifest(manifest),
    workbookInvocations: workbookAudit.calls,
    nativeWorkbooks: nativeWorkbooks.map((workbook) => ({
      fileName: workbook.fileName,
      semanticDigest: workbook.semanticDigest,
      sheets: workbook.sheets
    })),
    actualFiles: nativeFiles,
    missingManifestFiles
  };
  return Object.freeze({
    status: "succeeded",
    ...failure,
    finalDirectory,
    manifest,
    providerAudit,
    capture,
    workbookAudit,
    nativeWorkbooks,
    overall,
    ads,
    overallText,
    adsText,
    nativeFiles,
    missingManifestFiles,
    workbookMode,
    nativeArtifactComplete: missingManifestFiles.length === 0,
    canonicalContractDigest: sha256(stableJson(canonicalContract)),
    canonicalContract
  });
}

function sanitizedReplay(capture) {
  return {
    schemaVersion: "v2-place-artifact-sanitized-replay.v1",
    organic: capture.organic,
    ads: {
      ...capture.ads,
      contractPresent: capture.ads?.contractPresent !== false
    },
    rawProviderResponseStored: false
  };
}

async function runTarget(options) {
  await fs.mkdir(options.targetRoot, { recursive: false });
  let replayFile = options.replayFile || "";
  if (options.replayValue) {
    replayFile = path.join(options.targetRoot, "input", "sanitized-replay.json");
    await fs.mkdir(path.dirname(replayFile), { recursive: true });
    await writeAtomicJson(replayFile, options.replayValue);
  }
  const child = await runChild({ ...options, replayFile });
  return inspectTarget(options.targetRoot, child, options.workbookMode);
}

function targetProjection(value, runRoot) {
  const ids = value.overall.rows.map((row) => row.place_id);
  const adPlaceIds = value.ads.rows.map((row) => row.place_id);
  return {
    status: value.status,
    exitCode: value.exitCode,
    actualExternalRequestCount: value.providerAudit.actualExternalRequestCount,
    fixtureTransportCallCount: value.providerAudit.fixtureTransportCallCount,
    responseStatus: value.providerAudit.response.status,
    parseStatus: value.providerAudit.response.parseStatus,
    providerTotal: value.manifest.counts?.naverOverall === undefined ? null : value.capture.organic.total,
    providerAdTotal: value.capture.ads.total,
    naturalRowCount: value.overall.rows.length,
    advertisementRowCount: value.ads.rows.length,
    naturalPlaceIds: ids,
    advertisementPlaceIds: adPlaceIds,
    naturalRanks: value.overall.rows.map((row) => Number(row.overall_rank)),
    advertisementOrders: value.ads.rows.map((row) => Number(row.ad_order)),
    csvHeaders: { overall: value.overall.headers, advertisements: value.ads.headers },
    workbookInvocations: value.workbookAudit,
    nativeWorkbooks: value.nativeWorkbooks.map((workbook) => ({
      fileName: workbook.fileName,
      bytes: workbook.bytes,
      sha256: workbook.sha256,
      semanticDigest: workbook.semanticDigest,
      archiveEntryCount: workbook.archiveEntryCount,
      sheets: workbook.sheets.map((sheet) => ({
        name: sheet.name,
        headers: sheet.headers,
        rowCount: sheet.rows.length,
        physicalKinds: sheet.physicalKinds
      }))
    })),
    manifestSchemaVersion: value.manifest.schemaVersion,
    manifestFileRoles: value.manifest.fileRoles,
    nativeFiles: value.nativeFiles,
    missingManifestFiles: value.missingManifestFiles,
    nativeArtifactComplete: value.nativeArtifactComplete,
    canonicalContractDigest: value.canonicalContractDigest,
    evidenceDirectory: path.relative(runRoot, value.finalDirectory).split(path.sep).join("/")
  };
}

function structureOf(value) {
  return {
    naturalHeaders: value.overall.headers,
    adHeaders: value.ads.headers,
    workbook: value.workbookAudit.calls.map((call) => ({
      fileName: call.fileName,
      sheets: call.sheets.map((sheet) => ({ name: sheet.name, columns: sheet.columns, columnCellKinds: sheet.columnCellKinds }))
    })),
    nativeWorkbooks: value.nativeWorkbooks.map((workbook) => ({
      fileName: workbook.fileName,
      sheets: workbook.sheets.map((sheet) => ({
        name: sheet.name,
        headers: sheet.headers,
        physicalKinds: sheet.physicalKinds
      }))
    })),
    manifestKeys: Object.keys(value.manifest).sort(),
    fileRoleKeys: Object.keys(value.manifest.fileRoles || {}).sort(),
    missingManifestFiles: value.missingManifestFiles
  };
}

function compareTargets(original, replay, copied, mode) {
  const originalIds = original.overall.rows.map((row) => row.place_id);
  const copiedIds = copied.overall.rows.map((row) => row.place_id);
  const originalAds = original.ads.rows.map((row) => row.place_id);
  const copiedAds = copied.ads.rows.map((row) => row.place_id);
  const sharedIds = originalIds.filter((id) => copiedIds.includes(id));
  const sharedAdIds = originalAds.filter((id) => copiedAds.includes(id));
  const replayExact = original.canonicalContractDigest === replay.canonicalContractDigest;
  const structuralParity = stableJson(structureOf(original)) === stableJson(structureOf(copied));
  const independentExact = original.canonicalContractDigest === copied.canonicalContractDigest;
  return Object.freeze({
    schemaVersion: "v2-place-artifact-comparison.v1",
    replayExactArtifactParity: replayExact,
    independentStructuralParity: structuralParity,
    independentExactArtifactParity: mode === "offline" ? independentExact : null,
    liveDynamicObservation: mode === "live" ? {
      naturalCountPair: [originalIds.length, copiedIds.length],
      advertisementCountPair: [originalAds.length, copiedAds.length],
      sharedNaturalIdCount: sharedIds.length,
      originalOnlyNaturalIdCount: originalIds.length - sharedIds.length,
      copiedOnlyNaturalIdCount: copiedIds.length - sharedIds.length,
      sharedAdvertisementIdCount: sharedAdIds.length,
      naturalOrderExact: stableJson(originalIds) === stableJson(copiedIds),
      advertisementOrderExact: stableJson(originalAds) === stableJson(copiedAds)
    } : null
  });
}

async function writeAtomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await fs.rename(temporary, filePath);
}

async function runPair(inputJob, options = {}) {
  const job = normalizeJob(inputJob);
  const baseline = await verifyBaseline();
  const dependency = workbookDependencyStatus();
  if (job.mode === "live") assertLiveApproval(job, dependency);
  const evidenceRoot = assertEvidenceRoot(options.evidenceRoot || OUTPUT_ROOT, options.allowTestRoot);
  const runRoot = path.join(evidenceRoot, job.runId);
  await fs.mkdir(evidenceRoot, { recursive: true });
  try {
    await fs.mkdir(runRoot, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") fail("V2_PLACE_ARTIFACT_RUN_ALREADY_EXISTS", "run ID already exists; overwrite is forbidden");
    throw error;
  }
  const sourceManifest = JSON.parse(await fs.readFile(SOURCE_MANIFEST_PATH, "utf8"));
  const copiedRoot = path.join(runRoot, "copied-source");
  await materializeCopy(sourceManifest, copiedRoot);
  const workbookMode = dependency.installed ? "native" : "projection";
  const transportMode = job.mode === "live" ? "live" : "offline";
  const original = await runTarget({
    moduleRoot: ROOT,
    job,
    targetRoot: path.join(runRoot, "original"),
    transportMode,
    workbookMode
  });
  if (original.status !== "succeeded") fail("V2_PLACE_ARTIFACT_ORIGINAL_FAILED", "original collector path failed");
  const replay = await runTarget({
    moduleRoot: copiedRoot,
    job,
    targetRoot: path.join(runRoot, "replay"),
    transportMode: "replay",
    replayValue: sanitizedReplay(original.capture),
    workbookMode
  });
  if (replay.status !== "succeeded") fail("V2_PLACE_ARTIFACT_REPLAY_FAILED", "copied parser/writer replay failed");
  const copied = await runTarget({
    moduleRoot: copiedRoot,
    job,
    targetRoot: path.join(runRoot, "copied"),
    transportMode,
    workbookMode
  });
  if (copied.status !== "succeeded") fail("V2_PLACE_ARTIFACT_COPY_FAILED", "copied collector path failed");
  const comparison = compareTargets(original, replay, copied, job.mode);
  if (!comparison.replayExactArtifactParity || !comparison.independentStructuralParity) {
    fail("V2_PLACE_ARTIFACT_PARITY_MISMATCH", "Place artifact contract parity failed");
  }
  if (job.mode === "offline" && !comparison.independentExactArtifactParity) {
    fail("V2_PLACE_ARTIFACT_FIXTURE_PARITY_MISMATCH", "offline original/copy artifact parity failed");
  }
  const actualExternalRequestCount = original.providerAudit.actualExternalRequestCount
    + replay.providerAudit.actualExternalRequestCount
    + copied.providerAudit.actualExternalRequestCount;
  if (actualExternalRequestCount !== (job.mode === "live" ? 2 : 0)) {
    fail("V2_PLACE_ARTIFACT_EXTERNAL_REQUEST_COUNT_INVALID", "external request count escaped the approved pair budget");
  }
  const result = {
    schemaVersion: "v2-place-artifact-pair-result.v1",
    runId: job.runId,
    mode: job.mode,
    baseline,
    dependency,
    jobApprovalDigest: jobApprovalDigest(job),
    requestContract: {
      method: "GET",
      origin: "https://pcmap.place.naver.com",
      path: "/accommodation/list",
      queryParameterNames: ["query"],
      targetRequestBudget: 1,
      pairExternalRequestBudget: job.mode === "live" ? 2 : 0,
      timeoutMs: job.timeoutMs,
      responseSizeLimitBytes: job.responseSizeLimitBytes,
      retries: 0,
      fallbacks: 0
    },
    original: targetProjection(original, runRoot),
    replay: targetProjection(replay, runRoot),
    copied: targetProjection(copied, runRoot),
    comparison,
    classification: {
      native: workbookMode === "native"
        ? ["csv", "xlsx", "report", "manifest"]
        : ["csv", "report", "manifest"],
      comparisonOnly: workbookMode === "native"
        ? ["sanitized replay", "pair result"]
        : ["workbook invocation projection", "sanitized replay", "pair result"],
      nativePlaceOnlyJson: false
    },
    externalRequestCount: actualExternalRequestCount,
    bookingRequests: 0,
    priceInventoryRequests: 0,
    regionalRequests: 0,
    otaRequests: 0,
    retries: 0,
    fallbacks: 0,
    operationalWrites: 0,
    rawProviderResponsesStored: false
  };
  await writeAtomicJson(path.join(runRoot, "pair-result.json"), result);
  return Object.freeze(result);
}

async function runFailureFixture({ inputJob, evidenceRoot, workbookFailAt = 1, allowTestRoot = false }) {
  const job = normalizeJob(inputJob);
  if (job.mode !== "offline") fail("V2_PLACE_ARTIFACT_JOB_MODE_INVALID", "failure fixture must be offline");
  await verifyBaseline();
  const root = assertEvidenceRoot(evidenceRoot, allowTestRoot);
  const targetRoot = path.join(root, job.runId);
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(targetRoot, { recursive: false });
  const child = await runChild({
    moduleRoot: ROOT,
    job,
    targetRoot,
    transportMode: "offline",
    workbookMode: "projection",
    workbookFailAt
  });
  const inspected = await inspectTarget(targetRoot, child, "projection");
  if (inspected.status !== "failed") fail("V2_PLACE_ARTIFACT_FAILURE_FIXTURE_INVALID", "failure fixture unexpectedly succeeded");
  if (inspected.finalDirectoryCount !== 0 || inspected.pendingDirectoryCount !== 0) {
    fail("V2_PLACE_ARTIFACT_PARTIAL_PUBLICATION", "partial artifact escaped staging cleanup");
  }
  return Object.freeze(inspected);
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!new Set(["validate", "offline-pair", "live-pair"]).has(command)) {
    fail("V2_PLACE_ARTIFACT_COMMAND_INVALID", "command must be validate, offline-pair, or live-pair");
  }
  if (rest.length !== 2 || rest[0] !== "--job" || !rest[1]) {
    fail("V2_PLACE_ARTIFACT_COMMAND_INVALID", "command requires exactly --job <file>");
  }
  return { command, jobFile: rest[1] };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const job = await readJob(cli.jobFile);
  if (cli.command === "validate") {
    const baseline = await verifyBaseline();
    return { status: "validated", runId: job.runId, mode: job.mode, jobApprovalDigest: jobApprovalDigest(job), baseline, dependency: workbookDependencyStatus() };
  }
  if (cli.command === "offline-pair" && job.mode !== "offline") fail("V2_PLACE_ARTIFACT_JOB_MODE_INVALID", "offline-pair requires an offline job");
  if (cli.command === "live-pair" && job.mode !== "live") fail("V2_PLACE_ARTIFACT_JOB_MODE_INVALID", "live-pair requires a live job");
  return runPair(job);
}

if (require.main === module) {
  main().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "v2-place-artifact-error.v1",
      status: "failed",
      code: String(error?.code || "V2_PLACE_ARTIFACT_FAILED"),
      retryable: false
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ALLOWED_SCENARIOS,
  BASELINE_COMMIT,
  COLLECTOR_BLOB,
  LOCKFILE_SHA256,
  OUTPUT_ROOT,
  SOURCE_MANIFEST_DIGEST,
  V2PlaceArtifactError,
  childEnvironment,
  jobApprovalDigest,
  normalizeJob,
  parseCsv,
  runFailureFixture,
  runPair,
  stableJson,
  verifyBaseline,
  workbookDependencyStatus
};
