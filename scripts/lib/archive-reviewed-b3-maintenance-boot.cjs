"use strict";
// Explicit one-operation maintenance retirement. Never an age/PID-based lease
// reclaimer. Only the original marker may move; no source/queue/config writes.
const fs = require("node:fs/promises"), C = require("node:fs").constants, path = require("node:path"), crypto = require("node:crypto"), zlib = require("node:zlib"), { spawn } = require("node:child_process");
const { Transform, Writable } = require("node:stream"), { pipeline } = require("node:stream/promises");
const OP = "ea380222-d4db-46f4-a924-bc20bee7bdc6", RELEASE = "identity-auto-release-20261116-0e7fbd45-dbee-446c-817a-caebdd01b3ae", SERVICE = "srv-da9q6don74is738t7id0";
const PINS = Object.freeze({ marker: "c12d01111b959d1c54a22a04b46c2f12602d557039eb3d8d60b836c42cf0ced8", request: "81e38b057e5c164c9b3efad42d9eb722009c2cd50451b1bec1160d358ee48f54", runner: "9cc93912ed9402b3d46fe1af573a5aa33d9e3cb7bd8dcee74a2de87d2f55d43e", publicPointer: "480c75f2091633326e18b0b5877b6a4f4467e63891e215bdf8616a74f50bb385", sourcePointer: "970922410e6e090373bfa217a34ca1b9148c3d01a9063d2d570ab85d219749dd", state: "68eef0e8d994f717b38a31e6fa85c4679962e87ba947355aa8fae240dc187c18", renameHelper: "e95e17435a7076d336704b8546c78d02f60a862762a35313e243697999718148" });
const SHA = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, STAT_KEYS = ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink", "mode", "uid", "gid"];
const EXPECTED_STAT = Object.freeze({ ino: "135969", size: "316", mtimeNs: "1794804379629374397", ctimeNs: "1794804379629374397", nlink: "1", mode: "33152", uid: "1000", gid: "1000" });
const CONTEXT_MODULE_SHA = "65bcb1bdae162eda918327e4b31340fb329d7d3600dcc8e1157096ceab81da2b";
const REQUEST_BINDING_SHA = "2f4670ecebd619f0439e694737b863cfad95491f20aa82a965ba0b6f1cee2efb";
const sha = raw => crypto.createHash("sha256").update(raw).digest("hex"), obj = value => value && typeof value === "object" && !Array.isArray(value), exact = (value, keys) => obj(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const need = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
const stat = value => Object.fromEntries(STAT_KEYS.map(key => [key, String(value[key])])), same = (a, b) => STAT_KEYS.every(key => a[key] === b[key]);
const validIso = value => typeof value === "string" && /^20\d{2}-\d\d-\d\dT.*Z$/.test(value) && Number.isFinite(Date.parse(value));
async function checked(file, directory = false) {
  const absolute = path.resolve(file), root = path.parse(absolute).root; let item = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) { item = path.join(item, part); const current = await fs.lstat(item, { bigint: true }); need(!current.isSymbolicLink() && path.resolve(await fs.realpath(item)) === item && (item === absolute || current.isDirectory()), "B3_ARCHIVE_UNSAFE_PATH"); }
  const current = await fs.lstat(absolute, { bigint: true }); need(directory ? current.isDirectory() : current.isFile() && current.nlink === 1n, "B3_ARCHIVE_UNSAFE_PATH"); return stat(current);
}
async function read(file, limit, json = true) {
  const before = await checked(file); need(Number(before.size) > 0 && Number(before.size) <= limit, "B3_ARCHIVE_FILE_BOUND"); const handle = await fs.open(file, C.O_RDONLY | (C.O_NOFOLLOW || 0)); let bytes;
  try { need(same(before, stat(await handle.stat({ bigint: true }))), "B3_ARCHIVE_FILE_CHANGED"); const buffer = Buffer.alloc(Number(before.size) + 1); let at = 0;
    while (at < buffer.length) { const row = await handle.read(buffer, at, buffer.length - at, at); if (!row.bytesRead) break; at += row.bytesRead; }
    need(at === Number(before.size) && same(before, stat(await handle.stat({ bigint: true }))) && same(before, await checked(file)), "B3_ARCHIVE_FILE_CHANGED"); bytes = buffer.subarray(0, at);
  } finally { await handle.close(); }
  let value = null; if (json) { try { value = JSON.parse(bytes.toString("utf8")); } catch { need(false, "B3_ARCHIVE_JSON_INVALID"); } need(obj(value), "B3_ARCHIVE_JSON_INVALID"); }
  return { file, stat: before, sha256: sha(bytes), value, bytes };
}
async function absent(file) { try { await fs.lstat(file); need(false, "B3_ARCHIVE_EXPECTED_ABSENT"); } catch (error) { if (error.code !== "ENOENT") throw error; } }
function privateDirectory(statValue, fixture) { return fixture || statValue.uid === String(process.getuid()) && (BigInt(statValue.mode) & 0o777n) === 0o700n; }
async function syncDirectory(file, fixture) { if (fixture && process.platform === "win32") return; const handle = await fs.open(file, C.O_RDONLY | (C.O_DIRECTORY || 0)); try { await handle.sync(); } finally { await handle.close(); } }
async function writeNew(file, value, fixture) { const bytes = Buffer.from(JSON.stringify(value)), handle = await fs.open(file, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } const result = await read(file, 65536); need(result.sha256 === sha(bytes), "B3_ARCHIVE_RECEIPT_READBACK"); await syncDirectory(path.dirname(file), fixture); return result; }
function validatePolicy(value, expected, fixture = false) {
  need(exact(value, ["schemaVersion", "kind", "reviewedBy", "reviewedAt", "serviceId", "operationId", "marker", "fixedPins", "witness", "retirement", "preChildPolicy", "preChildInventoryPreobserved", "executionPolicy", "codePins", "pythonExecutable"]), "B3_ARCHIVE_REVIEW_SCHEMA");
  need(value.schemaVersion === 2 && value.kind === "reviewed-code-policy-next-single-runtime" && value.reviewedBy === "codex_root_operator" && validIso(value.reviewedAt) && value.serviceId === SERVICE && value.operationId === OP, "B3_ARCHIVE_REVIEW_BINDING");
  need(exact(value.marker, ["sha256", "bytes", "pid", "createdAt", "mode", "oldContextBinding"]) && value.marker.sha256 === expected.marker && value.marker.bytes === 316 && value.marker.pid === 1798 && value.marker.createdAt === "2026-11-16T04:46:19.629Z" && value.marker.mode === "stage" && value.marker.oldContextBinding === "exact_reviewed_marker_sha256", "B3_ARCHIVE_REVIEW_BINDING");
  need(exact(value.fixedPins, ["requestSha256", "requestBindingSha256", "runnerSha256", "publicPointerSha256", "sourcePointerSha256", "stateSha256"]) && value.fixedPins.requestSha256 === expected.request && value.fixedPins.requestBindingSha256 === REQUEST_BINDING_SHA && value.fixedPins.runnerSha256 === expected.runner && value.fixedPins.publicPointerSha256 === expected.publicPointer && value.fixedPins.sourcePointerSha256 === expected.sourcePointer && value.fixedPins.stateSha256 === expected.state, "B3_ARCHIVE_REVIEW_PINS");
  need(exact(value.witness, ["deploymentId", "commit", "contextSha256", "observedAt", "observationReceiptSha256"]) && /^dep-[a-z0-9]+$/.test(value.witness.deploymentId || "") && /^[a-f0-9]{40}$/.test(value.witness.commit || "") && (fixture || value.witness.commit === "534dcf721ccc6e50be7cc2d091c87b758eb1e3da") && SHA.test(value.witness.contextSha256 || "") && SHA.test(value.witness.observationReceiptSha256 || ""), "B3_ARCHIVE_WITNESS_BINDING");
  need(exact(value.retirement, ["oldRetiredNoLaterThan", "providerStopBeforeNewContractSha256", "providerEvidenceSha256", "sourceObservationReceiptSha256", "providerSingleRuntimePersistentDisk", "oldStoppedBeforeNew", "actualNewRuntimeMountedDisk"]) && value.retirement.providerSingleRuntimePersistentDisk === true && value.retirement.oldStoppedBeforeNew === true && value.retirement.actualNewRuntimeMountedDisk === true && ["providerStopBeforeNewContractSha256", "providerEvidenceSha256", "sourceObservationReceiptSha256"].every(key => SHA.test(value.retirement[key] || "")), "B3_ARCHIVE_REVIEW_EVIDENCE_REQUIRED");
  need(validIso(value.witness.observedAt) && validIso(value.retirement.oldRetiredNoLaterThan) && Date.parse(value.marker.createdAt) < Date.parse(value.retirement.oldRetiredNoLaterThan) && Date.parse(value.retirement.oldRetiredNoLaterThan) <= Date.parse(value.witness.observedAt) && Date.parse(value.witness.observedAt) <= Date.parse(value.reviewedAt), "B3_ARCHIVE_RETIREMENT_BOUND");
  need(value.preChildPolicy === "exact_frozen_pre_child_whitelist_v1" && value.preChildInventoryPreobserved === false && value.executionPolicy === "next_single_runtime_approved_code_then_verified_archive_only", "B3_ARCHIVE_PRECHILD_POLICY_NOT_APPROVED");
  need(exact(value.codePins, ["retirementModuleSha256", "contextModuleSha256", "renameHelperSha256", "bootShim"]) && ["retirementModuleSha256", "contextModuleSha256", "renameHelperSha256"].every(key => SHA.test(value.codePins[key] || "")) && value.codePins.contextModuleSha256 === CONTEXT_MODULE_SHA && value.codePins.renameHelperSha256 === expected.renameHelper && exact(value.codePins.bootShim, ["path", "sha256"]) && path.isAbsolute(value.codePins.bootShim.path || "") && SHA.test(value.codePins.bootShim.sha256 || ""), "B3_ARCHIVE_REVIEW_CODE_POLICY");
  need(exact(value.pythonExecutable, ["path", "trustPolicy"]) && (fixture ? path.isAbsolute(value.pythonExecutable.path || "") : value.pythonExecutable.path === "/usr/bin/python3.11") && value.pythonExecutable.trustPolicy === "canonical_root_owned_system_python311", "B3_ARCHIVE_REVIEW_PYTHON_PIN");
}
async function preChildOperationInventory({ directory, requestSha256, requestBindingSha256 = REQUEST_BINDING_SHA, fixture = false }) {
  const entries = [], directories = [], fullStats = []; let total = 0;
  try { await checked(directory, true); } catch (error) { if (error.code === "ENOENT") { const value = { present: false, entries: [], directories: [] }; return { ...value, sha256: sha(JSON.stringify(value)), fullStatSha256: sha("[]"), bytes: 0, files: 0 }; } throw error; }
  async function visit(dir, relative, depth) {
    need(depth <= 10 && entries.length + directories.length < 2000, "B3_ARCHIVE_PRECHILD_BOUND"); const before = await checked(dir, true); need(privateDirectory(before, fixture), "B3_ARCHIVE_PRECHILD_PERMISSIONS");
    const nonDev = { ...before }; delete nonDev.dev; directories.push({ relative, stat: nonDev });
    fullStats.push({ relative, directory: true, stat: before });
    const listed = await fs.readdir(dir, { withFileTypes: true }); need(listed.length <= 2000, "B3_ARCHIVE_PRECHILD_BOUND");
    for (const entry of listed.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = relative ? relative + "/" + entry.name : entry.name, file = path.join(dir, entry.name);
      const seed = child === "stage-seeds" || child === "stage-seeds/company_integrated" || child === "stage-seeds/history" || child === "stage-seeds/history/special_days" || child === "stage-seeds/history/saved_product_recoveries" || child.startsWith("stage-seeds/history/special_days/") || child.startsWith("stage-seeds/history/saved_product_recoveries/") || child === "stage-seeds/company_integrated/capacity-bases.json";
      need(!entry.isSymbolicLink() && !child.endsWith(".tmp") && !child.endsWith(".incomplete") && (relative ? seed : ["request.json", "request-binding.json", "originals.json", "stage-seeds"].includes(child)), "B3_ARCHIVE_PRECHILD_UNKNOWN_PATH");
      if (entry.isDirectory()) { need(seed && child !== "stage-seeds/company_integrated/capacity-bases.json", "B3_ARCHIVE_PRECHILD_UNKNOWN_PATH"); await visit(file, child, depth + 1); }
      else { need(entry.isFile() && !["stage-seeds", "stage-seeds/company_integrated", "stage-seeds/history", "stage-seeds/history/special_days", "stage-seeds/history/saved_product_recoveries"].includes(child), "B3_ARCHIVE_PRECHILD_UNKNOWN_PATH"); const item = ["request.json", "request-binding.json"].includes(child) ? await read(file, 65536) : { stat: await checked(file), sha256: null, value: null };
        need(Number(item.stat.size) <= 8 * 1048576, "B3_ARCHIVE_PRECHILD_BOUND"); total += Number(item.stat.size); need(total <= 64 * 1048576, "B3_ARCHIVE_PRECHILD_BOUND");
        need(fixture || item.stat.uid === String(process.getuid()) && (BigInt(item.stat.mode) & 0o777n) === 0o600n, "B3_ARCHIVE_PRECHILD_PERMISSIONS");
        if (child === "request.json") need(item.sha256 === requestSha256, "B3_ARCHIVE_PRECHILD_REQUEST");
        if (child === "request-binding.json") need(item.value.requestSha256 === requestSha256 && item.sha256 === requestBindingSha256, "B3_ARCHIVE_PRECHILD_REQUEST");
        const nonDevStat = { ...item.stat }; delete nonDevStat.dev; entries.push({ relative: child, stat: nonDevStat, sha256: item.sha256 });
        fullStats.push({ relative: child, directory: false, stat: item.stat });
      }
    }
    need(same(before, await checked(dir, true)), "B3_ARCHIVE_PRECHILD_CHANGED");
  }
  await visit(directory, "", 0); need(entries.some(value => value.relative === "request.json") && entries.some(value => value.relative === "request-binding.json"), "B3_ARCHIVE_PRECHILD_REQUEST");
  for (const entry of entries) { const now = await checked(path.join(directory, ...entry.relative.split("/"))); delete now.dev; need(JSON.stringify(now) === JSON.stringify(entry.stat), "B3_ARCHIVE_PRECHILD_CHANGED"); }
  for (const entry of fullStats) need(same(entry.stat, await checked(path.join(directory, ...entry.relative.split("/")), entry.directory)), "B3_ARCHIVE_PRECHILD_CHANGED");
  const value = { present: true, entries, directories }; return { ...value, sha256: sha(JSON.stringify(value)), fullStatSha256: sha(JSON.stringify(fullStats)), bytes: total, files: entries.length };
}
async function stateProof(root, descriptor) {
  need(descriptor.schemaVersion === 1 && descriptor.compression === "gzip" && SHA.test(descriptor.stateSha256 || "") && SHA.test(descriptor.storageSha256 || "") && Number.isSafeInteger(descriptor.storageBytes) && descriptor.storageBytes > 0 && descriptor.storageBytes <= 24 * 1048576 && Number.isSafeInteger(descriptor.rawBytes) && descriptor.rawBytes > 0 && descriptor.rawBytes <= 24 * 1048576, "B3_ARCHIVE_STATE_DESCRIPTOR_INVALID");
  const file = path.join(root, "states", descriptor.stateSha256 + ".json.gz"), before = await checked(file); need(Number(before.size) === descriptor.storageBytes, "B3_ARCHIVE_STATE_STORAGE_MISMATCH");
  const handle = await fs.open(file, C.O_RDONLY | (C.O_NOFOLLOW || 0)), compressedHash = crypto.createHash("sha256"), rawHash = crypto.createHash("sha256"), controller = new AbortController(); let compressedBytes = 0, rawBytes = 0;
  const timer = setTimeout(() => controller.abort(), 10000);
  try { need(same(before, stat(await handle.stat({ bigint: true }))), "B3_ARCHIVE_STATE_CHANGED");
    await pipeline(handle.createReadStream({ autoClose: false, start: 0, end: descriptor.storageBytes - 1, highWaterMark: 1024 * 1024 }), new Transform({ transform(bytes, _, callback) { compressedBytes += bytes.length; if (compressedBytes > descriptor.storageBytes) return callback(Object.assign(new Error("bound"), { code: "B3_ARCHIVE_STATE_STORAGE_MISMATCH" })); compressedHash.update(bytes); callback(null, bytes); } }), zlib.createGunzip(), new Writable({ write(bytes, _, callback) { rawBytes += bytes.length; if (rawBytes > descriptor.rawBytes || rawBytes > 24 * 1048576) return callback(Object.assign(new Error("bound"), { code: "B3_ARCHIVE_STATE_CONTENT_MISMATCH" })); rawHash.update(bytes); callback(); } }), { signal: controller.signal });
    need(compressedBytes === descriptor.storageBytes && compressedHash.digest("hex") === descriptor.storageSha256 && rawBytes === descriptor.rawBytes && rawHash.digest("hex") === descriptor.stateSha256, "B3_ARCHIVE_STATE_CONTENT_MISMATCH");
    need(same(before, stat(await handle.stat({ bigint: true }))) && same(before, await checked(file)), "B3_ARCHIVE_STATE_CHANGED"); return { file, stat: before, storageSha256: descriptor.storageSha256, rawSha256: descriptor.stateSha256 };
  } catch (error) { if (/^B3_ARCHIVE_/.test(error.code || "")) throw error; throw Object.assign(new Error("B3_ARCHIVE_STATE_READ_HOLD"), { code: "B3_ARCHIVE_STATE_READ_HOLD" }); }
  finally { clearTimeout(timer); await handle.close(); }
}
async function kernelRename({ python, helper, input }, testDependencies = null) {
  return new Promise((resolve, reject) => { let output = "", forcedError = null; const spawnOwnChild = testDependencies?.spawn || spawn, child = spawnOwnChild(python, ["-I", "-S", helper], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", LANG: "C" }, windowsHide: true });
    const forceHold = code => { if (!forcedError) forcedError = Object.assign(new Error(code), { code }); child.kill("SIGKILL"); };
    const timer = setTimeout(() => forceHold("B3_ARCHIVE_RENAME_TIMEOUT"), testDependencies?.milliseconds || 5000);
    child.on("error", () => { forcedError ||= Object.assign(new Error("B3_ARCHIVE_RENAME_UNAVAILABLE"), { code: "B3_ARCHIVE_RENAME_UNAVAILABLE" }); });
    child.stdout.on("data", bytes => { if (forcedError) return; output += bytes.toString("utf8"); if (output.length > 4096) forceHold("B3_ARCHIVE_RENAME_OUTPUT_BOUND"); });
    child.stdin.on("error", () => {}); child.on("close", code => { clearTimeout(timer); let result; try { result = JSON.parse(output); } catch {} if (forcedError) reject(forcedError); else if (code === 0 && result?.status === "renamed" && result.noReplace === true) resolve(); else reject(Object.assign(new Error("B3_ARCHIVE_RENAME_HELD"), { code: "B3_ARCHIVE_RENAME_HELD" })); }); child.stdin.end(JSON.stringify(input));
  });
}
async function archiveReviewedB3({ dataDir, codeRoot, receiptPath, receiptSha256, currentDeploymentId, currentCommit, archiveExactReviewedB3 } = {}, dependencies = {}) {
  need(archiveExactReviewedB3 === true && [dataDir, codeRoot, receiptPath].every(value => typeof value === "string" && path.isAbsolute(value)) && SHA.test(receiptSha256 || ""), "B3_ARCHIVE_EXPLICIT_ARGUMENTS_REQUIRED");
  const fixture = dependencies.fixture === true; need(fixture || process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 1000, "B3_ARCHIVE_PLATFORM_UNVERIFIED");
  dataDir = path.resolve(dataDir); codeRoot = path.resolve(codeRoot); const pins = fixture ? { ...PINS, ...dependencies.pins } : PINS, expectedStat = fixture ? dependencies.expectedStat : EXPECTED_STAT;
  need(fixture || dataDir === "/var/data" && codeRoot === "/opt/render/project/src", "B3_ARCHIVE_RUNTIME_PATH_UNVERIFIED");
  need(obj(expectedStat) && Object.values(pins).every(value => SHA.test(value)), "B3_ARCHIVE_PIN_INVALID");
  const root = path.join(dataDir, "keyword_monthly_incremental"), markerFile = path.join(root, "prepared-conversion-lock.json"), release = path.join(dataDir, "operations", RELEASE), opDir = path.join(dataDir, "operations/keyword-identity-prepared-20261116", OP), jobDir = path.join(root, "jobs", "refresh-job-" + OP), archiveBase = path.join(root, "maintenance-retirements"), archiveDir = path.join(archiveBase, OP), archiveFile = path.join(archiveDir, "retired-original.json"), helper = path.join(__dirname, "rename-reviewed-b3-noreplace.py");
  let crossedRenameBoundary = false, auditCreated = false;
  let contextReader, contextModule;
  try {
    const parent = await checked(root, true); need(privateDirectory(parent, fixture), "B3_ARCHIVE_PARENT_NOT_PRIVATE");
    try { await fs.lstat(archiveDir); need(false, "B3_ARCHIVE_PRIOR_AUDIT_NEEDS_READBACK"); } catch (error) { if (error.code !== "ENOENT") throw error; } // Never replay a previous intent or uncertain rename.
    const named = { marker: [markerFile, 16384], request: [path.join(release, "b3-request-stage.json"), 65536], runner: [path.join(release, "rebuild-reviewed-monthly-publish-v4.cjs"), 1048576, false], publicPointer: [path.join(dataDir, "keyword_monthly_analysis/current.json"), 16384], sourcePointer: [path.join(root, "source-current.json"), 16384], receipt: [receiptPath, 65536] }, saved = {};
    for (const [key, [file, maximum, json]] of Object.entries(named)) saved[key] = await read(file, maximum, json !== false);
    for (const key of ["marker", "request", "runner", "publicPointer", "sourcePointer"]) need(saved[key].sha256 === pins[key], "B3_ARCHIVE_FROZEN_PIN_MISMATCH");
    need(saved.receipt.sha256 === receiptSha256, "B3_ARCHIVE_REVIEW_SHA_MISMATCH");
    if (fixture) contextReader = dependencies.contextReader;
    else { contextModule = await read(path.join(codeRoot, "scripts/lib/keyword_monthly_worker_lock.cjs"), 262144, false); need(contextModule.sha256 === CONTEXT_MODULE_SHA, "B3_ARCHIVE_CONTEXT_MODULE_MISMATCH"); contextReader = require(contextModule.file).createLinuxProcessReader().context; need(same(contextModule.stat, await checked(contextModule.file)), "B3_ARCHIVE_CONTEXT_MODULE_CHANGED"); }
    const marker = saved.marker.value; need(exact(marker, ["schemaVersion", "kind", "token", "pid", "createdAt", "operationId", "mode", "contextSha256"]) && marker.schemaVersion === 1 && marker.kind === "keyword_prepared_conversion_maintenance" && UUID.test(marker.token || "") && marker.pid === 1798 && marker.operationId === OP && marker.mode === "stage" && marker.createdAt === "2026-11-16T04:46:19.629Z" && SHA.test(marker.contextSha256 || ""), "B3_ARCHIVE_NOT_EXACT_MARKER");
    need(Object.keys(expectedStat).every(key => saved.marker.stat[key] === expectedStat[key]) && saved.marker.bytes.length === 316, "B3_ARCHIVE_MARKER_STAT_MISMATCH");
    need(saved.request.value.operationId === OP && saved.request.value.dataDir === dataDir && saved.request.value.codeRoot === path.join(release, "code") && saved.sourcePointer.value.stateSha256 === pins.state, "B3_ARCHIVE_SOURCE_BINDING");
    const currentContextSha256 = sha(JSON.stringify(await contextReader())); need(SHA.test(currentContextSha256) && currentContextSha256 !== marker.contextSha256, "B3_ARCHIVE_CONTEXT_NOT_DIFFERENT");
    const inventoryArgs = { directory: opDir, requestSha256: pins.request, requestBindingSha256: fixture ? dependencies.requestBindingSha256 : REQUEST_BINDING_SHA, fixture }, inventory = await preChildOperationInventory(inventoryArgs);
    validatePolicy(saved.receipt.value, pins, fixture); need(saved.receipt.value.witness.contextSha256 !== marker.contextSha256, "B3_ARCHIVE_REVIEW_CONTEXT");
    const selfCode = await read(__filename, 65536, false), shimCode = await read(saved.receipt.value.codePins.bootShim.path, 262144, false), shimRelative = path.relative(codeRoot, shimCode.file);
    need(selfCode.sha256 === saved.receipt.value.codePins.retirementModuleSha256 && shimCode.sha256 === saved.receipt.value.codePins.bootShim.sha256 && !shimRelative.startsWith("..") && !path.isAbsolute(shimRelative) && shimRelative.split(path.sep).slice(0, 2).join("/") === "scripts/lib", "B3_ARCHIVE_CODE_POLICY_MISMATCH");
    await absent(jobDir); // The narrow pre-child whitelist excludes every publish/child intent or completion.
    const sourceState = await stateProof(root, saved.sourcePointer.value);
    const pythonPin = saved.receipt.value.pythonExecutable, python = await read(pythonPin.path, 64 * 1048576, false), renameCode = await read(helper, 65536, false);
    need((fixture || python.stat.uid === "0" && (BigInt(python.stat.mode) & 0o022n) === 0n && (BigInt(python.stat.mode) & 0o111n) !== 0n) && renameCode.sha256 === pins.renameHelper, "B3_ARCHIVE_EXECUTABLE_PIN_MISMATCH");
    try { await fs.mkdir(archiveBase, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    need(privateDirectory(await checked(archiveBase, true), fixture), "B3_ARCHIVE_ARCHIVE_PARENT_NOT_PRIVATE");
    try { await fs.mkdir(archiveDir, { mode: 0o700 }); auditCreated = true; } catch (error) { if (error.code === "EEXIST") need(false, "B3_ARCHIVE_PRIOR_AUDIT_NEEDS_READBACK"); throw error; }
    need(privateDirectory(await checked(archiveDir, true), fixture), "B3_ARCHIVE_ARCHIVE_NOT_PRIVATE");
    const intent = { schemaVersion: 2, kind: "exact_b3_maintenance_retirement_intent", status: "intent", operationId: OP, markerSha256: pins.marker, markerBytes: 316, currentContextSha256, currentDeploymentId: null, actualCommitRuntimeAudit: currentCommit, witness: saved.receipt.value.witness, reviewedReceiptSha256: receiptSha256, reviewedPolicyKind: saved.receipt.value.kind, sourceObservationReceiptSha256: saved.receipt.value.retirement.sourceObservationReceiptSha256, providerEvidenceSha256: saved.receipt.value.retirement.providerEvidenceSha256, publicPointerSha256: pins.publicPointer, sourcePointerSha256: pins.sourcePointer, stateSha256: pins.state, preChildOperationInventorySha256: inventory.sha256, preChildOperationFullStatSha256: inventory.fullStatSha256, preChildPolicy: saved.receipt.value.preChildPolicy, preChildInventoryPreobserved: false, inventoryBodyReads: "frozen_request_and_binding_only", actualPythonExecutableSha256: python.sha256, actualPythonExecutableStat: python.stat, pythonExecutableDigestPreobserved: false, noReplace: true, providerRetirementIndependentlyVerified: false, cooperativeWriterBoundaryRequired: true };
    const intentRead = await writeNew(path.join(archiveDir, "archive-intent.json"), intent, fixture);
    await syncDirectory(archiveBase, fixture); await syncDirectory(root, fixture);
    if (fixture && dependencies.beforeFinalCheck) await dependencies.beforeFinalCheck();
    for (const [key, [file, maximum, json]] of Object.entries(named)) { const again = await read(file, maximum, json !== false); need(again.sha256 === saved[key].sha256 && same(again.stat, saved[key].stat), "B3_ARCHIVE_PRE_RENAME_CHANGED"); }
    need(sha(JSON.stringify(await contextReader())) === currentContextSha256, "B3_ARCHIVE_CONTEXT_CHANGED"); const inventoryAgain = await preChildOperationInventory(inventoryArgs); need(inventoryAgain.sha256 === inventory.sha256 && inventoryAgain.fullStatSha256 === inventory.fullStatSha256, "B3_ARCHIVE_PRECHILD_CHANGED"); await absent(jobDir); await absent(archiveFile);
    const sourceStateAgain = await stateProof(root, saved.sourcePointer.value); need(same(sourceState.stat, sourceStateAgain.stat), "B3_ARCHIVE_STATE_CHANGED");
    need(same(python.stat, await checked(python.file)) && same(renameCode.stat, await checked(renameCode.file)), "B3_ARCHIVE_EXECUTABLE_CHANGED");
    if (contextModule) need(same(contextModule.stat, await checked(contextModule.file)), "B3_ARCHIVE_CONTEXT_MODULE_CHANGED");
    need(same(selfCode.stat, await checked(selfCode.file)) && same(shimCode.stat, await checked(shimCode.file)), "B3_ARCHIVE_CODE_POLICY_CHANGED");
    const sourceDirectoryStat = await checked(root, true), destinationDirectoryStat = await checked(archiveDir, true);
    need(sourceDirectoryStat.dev === parent.dev && sourceDirectoryStat.ino === parent.ino && privateDirectory(sourceDirectoryStat, fixture) && privateDirectory(destinationDirectoryStat, fixture), "B3_ARCHIVE_PARENT_CHANGED");
    const input = { sourceDirectory: root, destinationDirectory: archiveDir, sourceName: "prepared-conversion-lock.json", destinationName: "retired-original.json", sourceStat: saved.marker.stat, sourceDirectoryStat, destinationDirectoryStat, sourceSha256: pins.marker };
    crossedRenameBoundary = true;
    await (fixture ? dependencies.renameNoReplace : kernelRename)({ python: pythonPin.path, helper, input, source: markerFile, destination: archiveFile });
    if (fixture && dependencies.afterRename) await dependencies.afterRename();
    const pythonAfter = await read(pythonPin.path, 64 * 1048576, false); need(pythonAfter.sha256 === python.sha256 && same(pythonAfter.stat, python.stat), "B3_ARCHIVE_POST_EXECUTABLE_CHANGED");
    const archived = await read(archiveFile, 316); need(archived.sha256 === pins.marker && ["dev", "ino", "size", "mtimeNs", "nlink", "mode", "uid", "gid"].every(key => archived.stat[key] === saved.marker.stat[key]), "B3_ARCHIVE_ARCHIVED_READBACK_FAILED");
    for (const key of ["publicPointer", "sourcePointer", "request", "runner", "receipt"]) { const again = await read(...named[key]); need(again.sha256 === saved[key].sha256 && same(again.stat, saved[key].stat), "B3_ARCHIVE_POST_RENAME_CHANGED"); }
    need(sha(JSON.stringify(await contextReader())) === currentContextSha256, "B3_ARCHIVE_POST_CONTEXT_CHANGED");
    const inventoryAfter = await preChildOperationInventory(inventoryArgs); need(inventoryAfter.sha256 === inventory.sha256 && inventoryAfter.fullStatSha256 === inventory.fullStatSha256, "B3_ARCHIVE_POST_PRECHILD_CHANGED"); await absent(jobDir); need(same(sourceState.stat, await checked(sourceState.file)), "B3_ARCHIVE_POST_STATE_CHANGED");
    let newGuardPresent = false; try { await fs.lstat(markerFile); newGuardPresent = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    const complete = { ...intent, kind: "exact_b3_maintenance_retirement_complete", status: newGuardPresent ? "archived_new_guard_present_hold" : "archived", oldMarkerStat: saved.marker.stat, archivedStat: archived.stat, archivedSha256: archived.sha256, archiveIntentSha256: intentRead.sha256, newGuardPresent, oldMarkerArchived: true, noCurrentGuardChanged: true, sourceWrites: 0, queueWrites: 0, configurationWrites: 0, originalWrites: 0, actionReplayAuthorized: false, fixture };
    if (fixture && dependencies.beforeComplete) await dependencies.beforeComplete();
    const completeRead = await writeNew(path.join(archiveDir, "archive-complete.json"), complete, fixture);
    if (newGuardPresent) throw Object.assign(new Error("B3_ARCHIVE_NEW_GUARD_PRESENT_HOLD"), { code: "B3_ARCHIVE_NEW_GUARD_PRESENT_HOLD", mutationState: "old_marker_archived_new_guard_untouched", completionReceiptSha256: completeRead.sha256 });
    return { schemaVersion: 2, status: "archived", operationId: OP, fixture, markerSha256: pins.marker, reviewedPolicySha256: receiptSha256, completionReceiptSha256: completeRead.sha256, archiveDirectory: archiveDir, noReplace: true, oldMarkerArchived: true, newGuardPresent: false, actualCommitRuntimeAudit: currentCommit, runtimeDeploymentId: null, sourceWrites: 0, queueWrites: 0, configurationWrites: 0, originalWrites: 0, networkAttempted: false, cmdlineRead: false, retirementReliesOnExplicitOperatorEvidence: true, actionReplayAuthorized: false };
  } catch (error) {
    if (crossedRenameBoundary && error.code !== "B3_ARCHIVE_NEW_GUARD_PRESENT_HOLD") throw Object.assign(new Error("B3_ARCHIVE_NEEDS_READBACK"), { code: "B3_ARCHIVE_NEEDS_READBACK", operationId: OP, archiveDirectory: archiveDir, mutationState: "rename_attempted_uncertain", originalCauseCode: /^B3_ARCHIVE_[A-Z0-9_]+$/.test(error.code || "") ? error.code : "B3_ARCHIVE_IO_UNAVAILABLE" });
    if (auditCreated && !crossedRenameBoundary) error.mutationState = "intent_or_private_audit_only_marker_not_moved";
    throw error;
  }
}
async function retireReviewedB3MaintenanceAtBoot({ dataDir, codeRoot, policyPath, policySha256, actualCommitRuntimeAudit = null } = {}, dependencies = {}) {
  need([dataDir, codeRoot, policyPath].every(value => typeof value === "string" && path.isAbsolute(value)) && SHA.test(policySha256 || ""), "B3_ARCHIVE_EXPLICIT_ARGUMENTS_REQUIRED");
  const fixture = dependencies.fixture === true, pins = fixture ? { ...PINS, ...dependencies.pins } : PINS; dataDir = path.resolve(dataDir); codeRoot = path.resolve(codeRoot);
  need(fixture || process.platform === "linux" && process.getuid?.() === 1000 && dataDir === "/var/data" && codeRoot === "/opt/render/project/src", "B3_ARCHIVE_RUNTIME_PATH_UNVERIFIED");
  need(actualCommitRuntimeAudit === null || exact(actualCommitRuntimeAudit, ["source", "available", "commit"]) && actualCommitRuntimeAudit.source === "git_metadata" && typeof actualCommitRuntimeAudit.available === "boolean" && (actualCommitRuntimeAudit.available ? /^[a-f0-9]{40}$/.test(actualCommitRuntimeAudit.commit || "") : actualCommitRuntimeAudit.commit === null), "B3_ARCHIVE_RUNTIME_AUDIT_INVALID");
  const policy = await read(policyPath, 65536), policyRelative = path.relative(codeRoot, policy.file), policyWithinCode = !policyRelative.startsWith("..") && !path.isAbsolute(policyRelative), policyMode = BigInt(policy.stat.mode) & 0o777n;
  const policyPermissions = policyWithinCode ? ["0", "1000"].includes(policy.stat.uid) && [0o600n, 0o644n].includes(policyMode) : policy.stat.uid === "1000" && policyMode === 0o600n;
  need(policy.sha256 === policySha256 && (fixture || policyPermissions), "B3_ARCHIVE_REVIEW_SHA_MISMATCH"); validatePolicy(policy.value, pins, fixture);
  const root = path.join(dataDir, "keyword_monthly_incremental"), markerFile = path.join(root, "prepared-conversion-lock.json"), archiveDir = path.join(root, "maintenance-retirements", OP);
  let marker = null; try { marker = await read(markerFile, 16384, false); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const unchanged = { schemaVersion: 2, operationId: OP, fixture, reviewedPolicySha256: policySha256, actualCommitRuntimeAudit, runtimeDeploymentId: null, sourceWrites: 0, queueWrites: 0, configurationWrites: 0, originalWrites: 0, operationalActions: 0, networkAttempted: false, cmdlineRead: false, actionReplayAuthorized: false };
  if (marker && marker.sha256 !== pins.marker) return { ...unchanged, status: "not_target", normalMaintenanceProtectionRequired: true, currentGuardUntouched: true };
  if (!marker) {
    try {
      need(privateDirectory(await checked(root, true), fixture) && privateDirectory(await checked(path.dirname(archiveDir), true), fixture) && privateDirectory(await checked(archiveDir, true), fixture), "B3_ARCHIVE_ARCHIVE_NOT_PRIVATE");
      const intent = await read(path.join(archiveDir, "archive-intent.json"), 65536), complete = await read(path.join(archiveDir, "archive-complete.json"), 65536), archived = await read(path.join(archiveDir, "retired-original.json"), 316);
      need([intent, complete, archived].every(value => fixture || value.stat.uid === "1000" && (BigInt(value.stat.mode) & 0o777n) === 0o600n), "B3_ARCHIVE_ARCHIVE_NOT_PRIVATE");
      need(intent.value.schemaVersion === 2 && intent.value.kind === "exact_b3_maintenance_retirement_intent" && intent.value.operationId === OP && intent.value.markerSha256 === pins.marker && intent.value.markerBytes === 316 && intent.value.reviewedReceiptSha256 === policySha256 && intent.value.reviewedPolicyKind === policy.value.kind && intent.value.noReplace === true, "B3_ARCHIVE_PRIOR_AUDIT_NEEDS_READBACK");
      need(complete.value.kind === "exact_b3_maintenance_retirement_complete" && ["archived", "archived_new_guard_present_hold"].includes(complete.value.status) && complete.value.operationId === OP && complete.value.reviewedReceiptSha256 === policySha256 && complete.value.archiveIntentSha256 === intent.sha256 && complete.value.archivedSha256 === pins.marker && complete.value.oldMarkerArchived === true && complete.value.noCurrentGuardChanged === true && complete.value.noReplace === true && complete.value.actionReplayAuthorized === false, "B3_ARCHIVE_PRIOR_AUDIT_NEEDS_READBACK");
      for (const [key, value] of Object.entries(intent.value)) if (key !== "kind" && key !== "status") need(JSON.stringify(complete.value[key]) === JSON.stringify(value), "B3_ARCHIVE_PRIOR_AUDIT_NEEDS_READBACK");
      need(archived.sha256 === pins.marker && archived.bytes.length === 316 && obj(complete.value.archivedStat) && STAT_KEYS.filter(key => key !== "dev").every(key => archived.stat[key] === complete.value.archivedStat[key]), "B3_ARCHIVE_PRIOR_AUDIT_NEEDS_READBACK");
      need(same(policy.stat, await checked(policy.file)) && same(intent.stat, await checked(intent.file)) && same(complete.stat, await checked(complete.file)) && same(archived.stat, await checked(archived.file)), "B3_ARCHIVE_PRIOR_AUDIT_NEEDS_READBACK");
      try { await fs.lstat(markerFile); return { ...unchanged, status: "not_target", normalMaintenanceProtectionRequired: true, currentGuardUntouched: true }; } catch (error) { if (error.code !== "ENOENT") throw error; }
      return { ...unchanged, status: "already_retired", oldMarkerArchived: true, completionReceiptSha256: complete.sha256, baselineFreshnessRevalidated: false };
    } catch { throw Object.assign(new Error("B3_ARCHIVE_NEEDS_READBACK"), { code: "B3_ARCHIVE_NEEDS_READBACK", operationId: OP, mutationState: "guard_absent_archive_chain_unverified" }); }
  }
  return archiveReviewedB3({ dataDir, codeRoot, receiptPath: policyPath, receiptSha256: policySha256, currentDeploymentId: null, currentCommit: actualCommitRuntimeAudit, archiveExactReviewedB3: true }, dependencies);
}
module.exports = { retireReviewedB3MaintenanceAtBoot, validatePolicy, preChildOperationInventory, kernelRename, PINS, EXPECTED_STAT };
