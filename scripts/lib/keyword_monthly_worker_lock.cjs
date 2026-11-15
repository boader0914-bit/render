"use strict";
// Host-only lock lifecycle and explicitly reviewed recovery. No application,
// provider, original source, collector or environment readers are imported.
const fs = require("node:fs/promises"), C = require("node:fs").constants;
const path = require("node:path"), crypto = require("node:crypto"), zlib = require("node:zlib"), os = require("node:os");
const { spawn } = require("node:child_process");
const SHA = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const VERSIONS = new Set(["keyword-monthly-incremental-v4", "keyword-monthly-incremental-v5"]);
const LOCK = "worker-lock.json", CLAIM = "worker-lock-recovery-claim.json", MAX_STATE = 24 * 1024 ** 2;
const CENTRAL_SERVICE = "srv-da9q6don74is738t7id0";
const ATOMIC_ARCHIVE_PROGRAM = "import ctypes,os,sys\nlib=ctypes.CDLL(None,use_errno=True)\nf=getattr(lib,'renameat2',None)\nif f is None: sys.exit(120)\nf.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]\nf.restype=ctypes.c_int\nr=f(-100,os.fsencode(sys.argv[1]),-100,os.fsencode(sys.argv[2]),1)\nsys.exit(0 if r==0 else min(119,ctypes.get_errno() or 1))\n";
const hash = b => crypto.createHash("sha256").update(b).digest("hex"), jsonBytes = v => Buffer.from(JSON.stringify(v));
const fault = code => Object.assign(new Error(code), { code });
const need = (v, code = "KEYWORD_INCREMENTAL_LOCK_RECOVERY_HOLD") => { if (!v) throw fault(code); };
const iso = v => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const same = (a, b) => ["dev", "ino", "size", "nlink", "mode", "uid", "gid", "mtimeNs", "ctimeNs"].every(k => String(a[k]) === String(b[k]));
const smallStat = s => Object.fromEntries(["dev", "ino", "size", "nlink", "mode", "uid", "gid", "mtimeNs", "ctimeNs"].map(k => [k, String(s[k])]));
const inside = (root, f) => { const r = path.relative(root, f); return r && r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r); };
async function checked(file, directory = false) {
  need(path.isAbsolute(file) && path.resolve(file) === file); let p = path.parse(file).root;
  for (const part of file.slice(p.length).split(path.sep).filter(Boolean)) { p = path.join(p, part); const s = await fs.lstat(p); need(!s.isSymbolicLink() && (p === file || s.isDirectory())); }
  const s = await fs.lstat(file, { bigint: true }); need(directory ? s.isDirectory() : s.isFile() && s.nlink === 1n); need(await fs.realpath(file) === file); return s;
}
async function read(file, max, binary = false) {
  const before = await checked(file); need(before.size > 0n && before.size <= BigInt(max), "KEYWORD_INCREMENTAL_LOCK_READ_BOUND");
  const h = await fs.open(file, C.O_RDONLY | (C.O_NOFOLLOW || 0)); let bytes;
  try { need(same(before, await h.stat({ bigint: true }))); const b = Buffer.alloc(Number(before.size) + 1); let at = 0;
    while (at < b.length) { const r = await h.read(b, at, b.length - at, at); if (!r.bytesRead) break; at += r.bytesRead; }
    need(at === Number(before.size) && same(before, await h.stat({ bigint: true }))); bytes = b.subarray(0, at);
  } finally { await h.close(); }
  need(same(before, await checked(file))); let value;
  if (!binary) { try { value = JSON.parse(bytes); } catch { throw fault("KEYWORD_INCREMENTAL_LOCK_JSON_INVALID"); } }
  return { file, bytes, value, stat: before, sha256: hash(bytes) };
}
async function maybe(file, max, binary = false) { try { return await read(file, max, binary); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
async function absent(file) { try { await fs.lstat(file); return false; } catch (e) { if (e.code === "ENOENT") return true; throw e; } }
async function privateDir(file, fixture = false) {
  try { await fs.mkdir(file, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  const s = await checked(file, true); need(fixture && process.platform === "win32" || (s.mode & 0o777n) === 0o700n && s.uid === BigInt(process.getuid())); return s;
}
async function writeNew(file, value) {
  const bytes = jsonBytes(value); need(bytes.length <= 65536); const h = await fs.open(file, "wx", 0o600);
  try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
  const r = await read(file, 65536); need(r.sha256 === hash(bytes)); return r;
}
async function syncDir(dir) { if (process.platform !== "win32") { const h = await fs.open(dir, C.O_RDONLY); try { await h.sync(); } finally { await h.close(); } } }
async function executablePin(file) {
  const real = await fs.realpath(file), s = await checked(real); need(s.size > 0n && s.size <= 128n * 1024n ** 2n && (s.mode & 0o022n) === 0n
    && (s.uid === 0n || s.uid === BigInt(process.getuid())), "KEYWORD_INCREMENTAL_LOCK_SYSTEM_HELPER_UNSAFE");
  let parent = path.dirname(real); while (true) { const p = await checked(parent, true); need((p.mode & 0o022n) === 0n && (p.uid === 0n || p.uid === BigInt(process.getuid())), "KEYWORD_INCREMENTAL_LOCK_SYSTEM_HELPER_UNSAFE"); const next = path.dirname(parent); if (next === parent) break; parent = next; }
  const h = await fs.open(real, C.O_RDONLY | (C.O_NOFOLLOW || 0)), digest = crypto.createHash("sha256"); let at = 0;
  try { const b = Buffer.alloc(65536); while (at < Number(s.size)) { const r = await h.read(b, 0, Math.min(b.length, Number(s.size) - at), at); need(r.bytesRead > 0); digest.update(b.subarray(0, r.bytesRead)); at += r.bytesRead; }
    need(same(s, await h.stat({ bigint: true })) && same(s, await checked(real)) && await fs.realpath(file) === real);
  } finally { await h.close(); }
  return { file: real, stat: s, sha256: digest.digest("hex") };
}
async function archiveNoReplace(source, destination, fixture) {
  if (process.platform !== "linux") { need(fixture === true, "KEYWORD_INCREMENTAL_LOCK_ATOMIC_ARCHIVE_UNAVAILABLE"); need(await absent(destination)); return fs.rename(source, destination); }
  // Node rename replaces an existing destination. This fixed, isolated Python
  // invocation performs only renameat2(RENAME_NOREPLACE), without a shell or
  // inherited environment, stdio, provider access or application imports.
  const systemPython = "/usr/bin/python3.11", pin = await executablePin(systemPython);
  const dir = await checked(path.dirname(destination), true); need((dir.mode & 0o777n) === 0o700n && dir.uid === BigInt(process.getuid()));
  await new Promise((resolve, reject) => {
    const p = spawn(pin.file, ["-I", "-S", "-c", ATOMIC_ARCHIVE_PROGRAM, source, destination], { cwd: path.dirname(destination), shell: false, stdio: ["ignore", "ignore", "ignore"], env: {}, windowsHide: true });
    let stopped = false; const timer = setTimeout(() => { stopped = true; try { p.kill("SIGKILL"); } catch {} }, 10000);
    p.once("error", () => { clearTimeout(timer); reject(fault("KEYWORD_INCREMENTAL_LOCK_ATOMIC_ARCHIVE_UNAVAILABLE")); });
    p.once("close", (exit, signal) => { clearTimeout(timer); if (stopped || signal || exit !== 0) reject(fault(exit === 17 ? "KEYWORD_INCREMENTAL_LOCK_ARCHIVE_EXISTS" : "KEYWORD_INCREMENTAL_LOCK_ATOMIC_ARCHIVE_FAILED")); else resolve(); });
  });
  const after = await executablePin(systemPython); need(after.file === pin.file && after.sha256 === pin.sha256 && same(after.stat, pin.stat), "KEYWORD_INCREMENTAL_LOCK_SYSTEM_HELPER_CHANGED");
  return { pythonSha256: pin.sha256, pythonIdentity: smallStat(pin.stat), inlineProgramSha256: hash(Buffer.from(ATOMIC_ARCHIVE_PROGRAM)), exitCode: 0, renameNoReplace: true };
}
async function pseudo(file, bound = 8192) {
  const h = await fs.open(file, C.O_RDONLY); try { const b = Buffer.alloc(bound + 1); let at = 0;
    while (at < b.length) { const r = await h.read(b, at, b.length - at, at); if (!r.bytesRead) break; at += r.bytesRead; }
    need(at <= bound, "KEYWORD_INCREMENTAL_PROCESS_UNKNOWN"); return b.subarray(0, at).toString("utf8");
  } finally { await h.close(); }
}
async function trustedClockTicks() {
  const systemGetconf = "/usr/bin/getconf", pin = await executablePin(systemGetconf);
  const output = await new Promise((resolve, reject) => {
    const p = spawn(pin.file, ["CLK_TCK"], { cwd: "/", shell: false, stdio: ["ignore", "pipe", "ignore"], env: {}, windowsHide: true });
    const chunks = []; let bytes = 0, denied = false;
    const stop = () => { denied = true; try { p.kill("SIGKILL"); } catch {} };
    const timer = setTimeout(stop, 5000);
    p.stdout.on("data", b => { bytes += b.length; if (bytes > 32) stop(); else chunks.push(b); });
    p.once("error", () => { clearTimeout(timer); reject(fault("KEYWORD_INCREMENTAL_LOCK_BIRTH_PROOF_UNKNOWN")); });
    p.once("close", (code, signal) => { clearTimeout(timer); if (denied || signal || code !== 0) reject(fault("KEYWORD_INCREMENTAL_LOCK_BIRTH_PROOF_UNKNOWN")); else resolve(Buffer.concat(chunks).toString("utf8")); });
  });
  need(/^[1-9]\d{0,5}\n$/.test(output), "KEYWORD_INCREMENTAL_LOCK_BIRTH_PROOF_UNKNOWN");
  const after = await executablePin(systemGetconf); need(after.file === pin.file && after.sha256 === pin.sha256 && same(after.stat, pin.stat), "KEYWORD_INCREMENTAL_LOCK_BIRTH_PROOF_UNKNOWN");
  return { ticksPerSecond: output.trim(), getconfSha256: pin.sha256, getconfIdentity: smallStat(pin.stat) };
}
function createLinuxProcessReader(options = {}) {
  need(process.platform === "linux", "KEYWORD_INCREMENTAL_PROCESS_PROOF_UNAVAILABLE");
  async function context() {
    const bootId = (await pseudo("/proc/sys/kernel/random/boot_id", 128)).trim(), pidNamespace = await fs.readlink("/proc/self/ns/pid");
    need(UUID.test(bootId) && /^pid:\[\d+\]$/.test(pidNamespace), "KEYWORD_INCREMENTAL_PROCESS_UNKNOWN");
    return { bootId, pidNamespace, hostId: hash(jsonBytes([os.hostname(), bootId])) };
  }
  async function processAt(pid) {
    need(Number.isSafeInteger(pid) && pid > 0, "KEYWORD_INCREMENTAL_PROCESS_UNKNOWN");
    try { const text = await pseudo("/proc/" + pid + "/stat"), end = text.lastIndexOf(")"), fields = text.slice(end + 2).trim().split(/\s+/);
      need(end > 1 && fields.length >= 20 && /^\d+$/.test(fields[19]), "KEYWORD_INCREMENTAL_PROCESS_UNKNOWN");
      const after = await pseudo("/proc/" + pid + "/stat"), a = after.slice(after.lastIndexOf(")") + 2).trim().split(/\s+/);
      need(a[19] === fields[19], "KEYWORD_INCREMENTAL_PROCESS_CHANGED");
      const exe = await fs.readlink("/proc/" + pid + "/exe"), cwd = await fs.readlink("/proc/" + pid + "/cwd"), st = await fs.stat("/proc/" + pid + "/exe", { bigint: true });
      const base = path.basename(exe), kind = /^(?:node|nodejs)$/.test(base) ? "node" : /^(?:sh|bash|dash)$/.test(base) ? "shell" : "other";
      const timeNamespace = await fs.readlink("/proc/" + pid + "/ns/time");
      return { pid, ppid: Number(fields[1]), startTicks: fields[19], state: fields[0], kind, timeNamespace,
        executableIdentity: hash(jsonBytes([exe, String(st.dev), String(st.ino), String(st.size)])), cwdIdentity: hash(Buffer.from(cwd)) };
    } catch (e) { if (["ENOENT", "ESRCH"].includes(e.code)) return null; throw e; }
  }
  async function peers(exclude = []) {
    const guard = options.providerPeerProof ? require("./keyword_monthly_provider_peer.cjs").createReviewedProviderPeerGuard({ proof: options.providerPeerProof,
      readContext: context, readServer: processAt, expectedServerPid: options.expectedServerPid, expectedJobId: options.expectedJobId, expectedLockSha256: options.expectedLockSha256 }) : null;
    if (guard) { need(!exclude.includes(guard.pid), "KEYWORD_INCREMENTAL_PROVIDER_PEER_UNVERIFIED"); await guard.verify(); }
    const entries = await fs.readdir("/proc", { withFileTypes: true }); need(entries.length <= 8192, "KEYWORD_INCREMENTAL_PROCESS_INVENTORY_BOUND"); const found = []; let reviewedSeen = false;
    for (const e of entries) if (/^\d+$/.test(e.name)) {
      const pid = Number(e.name); if (exclude.includes(pid)) continue;
      let s; try { s = await fs.lstat("/proc/" + pid); } catch (x) { if (x.code === "ENOENT") continue; throw x; }
      if (s.uid !== process.getuid()) continue;
      let exe; try { exe = path.basename(await fs.readlink("/proc/" + pid + "/exe")); } catch (x) {
        if (["ENOENT", "ESRCH"].includes(x.code)) continue;
        if (await require("./keyword_monthly_provider_peer.cjs").reviewedPeerReadFailure(guard, pid, x.code)) { reviewedSeen = true; continue; }
        throw fault("KEYWORD_INCREMENTAL_PROCESS_UNKNOWN");
      }
      if (/^(?:node(?:js)?|python(?:\d+(?:\.\d+)*)?)(?: \(deleted\))?$/.test(exe)) { const p = await processAt(pid); if (p) found.push({ pid: p.pid, ppid: p.ppid, startTicks: p.startTicks, kind: exe.startsWith("python") ? "python" : "node" }); }
    }
    if (guard) { need(reviewedSeen, "KEYWORD_INCREMENTAL_PROVIDER_PEER_CHANGED"); await guard.verify(); } return found;
  }
  async function clockBasis(startTicks) {
    const ticks = await trustedClockTicks(), ns = await fs.readlink("/proc/self/ns/time"), before = Date.now();
    const first = await pseudo("/proc/stat", 128 * 1024), btime = first.match(/^btime (\d+)$/gm), uptime = await pseudo("/proc/uptime", 256);
    const second = await pseudo("/proc/stat", 128 * 1024), afterBtime = second.match(/^btime (\d+)$/gm), after = Date.now();
    need(btime?.length === 1 && afterBtime?.length === 1 && btime[0] === afterBtime[0] && /^time:\[\d+\]$/.test(ns)
      && await fs.readlink("/proc/self/ns/time") === ns, "KEYWORD_INCREMENTAL_LOCK_BIRTH_PROOF_UNKNOWN");
    const bootEpochSeconds = btime[0].slice(6), up = Number(uptime.trim().split(/\s+/)[0]), boot = Number(bootEpochSeconds) * 1000;
    need(Number.isSafeInteger(boot) && Number.isFinite(up) && up >= 0 && up < 1e10 && after >= before && after - before <= 10000
      && after >= boot + Math.floor(up * 1000) - 2000 && before <= boot + Math.ceil(up * 1000) + 2000
      && /^\d+$/.test(startTicks || "") && Number(BigInt(startTicks) * 1000n / BigInt(ticks.ticksPerSecond)) <= up * 1000 + 2000, "KEYWORD_INCREMENTAL_LOCK_BIRTH_PROOF_UNKNOWN");
    // Only static boot/HZ/executable identity is returned. Fresh wall/uptime
    // samples are a gate, never part of a review hash shared by later processes.
    return { bootEpochSeconds, ...ticks, timeNamespace: ns, coherenceVerified: true };
  }
  return { context, process: processAt, peers, clockBasis };
}
function reader(options) {
  if (options.processReader) { need(options.fixture === true, "KEYWORD_INCREMENTAL_PROCESS_ADAPTER_FORBIDDEN"); return options.processReader; }
  if (options.fixture === true && process.platform !== "linux") {
    const c = { bootId: "00000000-0000-4000-8000-000000000000", pidNamespace: "fixture", hostId: "f".repeat(64) }, startTicks = "1";
    return { context: async () => c, process: async pid => pid === process.pid ? { pid, ppid: 1, startTicks } : null, peers: async () => [] };
  }
  return createLinuxProcessReader({ providerPeerProof: options.providerPeerProof, expectedServerPid: options.serverPid, expectedJobId: options.targetJobId, expectedLockSha256: options.expectedLockSha256 });
}
async function acquireWorkerLock(options) {
  const { directory, sourceKey, version, now = () => new Date() } = options; need(SHA.test(sourceKey || "") && VERSIONS.has(version)); const parent = await checked(directory, true);
  need(options.fixture === true && process.platform === "win32" || (parent.mode & 0o777n) === 0o700n && parent.uid === BigInt(process.getuid()));
  const claim = path.join(directory, CLAIM), file = path.join(directory, LOCK); need(await absent(claim), "KEYWORD_INCREMENTAL_LOCK_RECOVERY_IN_PROGRESS");
  const maintenanceAdmission = async () => {
    let state;
    try { state = await require("./keyword_monthly_maintenance.cjs").readPreparedConversionAdmission({ dataDir: path.dirname(directory) }); }
    catch { throw Object.assign(fault("KEYWORD_INCREMENTAL_PREPARED_CONVERSION_UNVERIFIED"), { deferred: true }); }
    if (state?.allowed !== true) throw Object.assign(fault(state?.reasonCode === "KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE"
      ? state.reasonCode : "KEYWORD_INCREMENTAL_PREPARED_CONVERSION_UNVERIFIED"), { deferred: true });
  };
  await maintenanceAdmission();
  const processes = reader(options), context = await processes.context(), self = await processes.process(process.pid); need(self && /^\d+$/.test(self.startTicks), "KEYWORD_INCREMENTAL_PROCESS_UNKNOWN");
  const secret = crypto.randomUUID(), jobId = crypto.randomUUID(), value = { schemaVersion: 2, token: secret, pid: process.pid, sourceKey, jobId, version,
    createdAt: new Date(now()).toISOString(), owner: { ...context, startTicks: self.startTicks } };
  let h; try { h = await fs.open(file, "wx", 0o600); } catch (e) { if (e.code === "EEXIST") throw fault("KEYWORD_INCREMENTAL_WORKER_LOCKED"); throw e; }
  const own = await h.stat({ bigint: true }); let complete = false;
  try { need(await absent(claim), "KEYWORD_INCREMENTAL_LOCK_RECOVERY_IN_PROGRESS"); await maintenanceAdmission(); await h.writeFile(jsonBytes(value)); await h.sync(); complete = true; }
  finally { await h.close(); if (!complete) { const s = await fs.lstat(file, { bigint: true }).catch(() => null); if (s && s.dev === own.dev && s.ino === own.ino && s.nlink === 1n) await fs.unlink(file); } }
  const initial = await read(file, 16384); need(initial.value.token === secret && initial.value.jobId === jobId);
  let released = false;
  return Object.freeze({ jobId, async release() {
    need(!released, "KEYWORD_INCREMENTAL_LOCK_ALREADY_RELEASED"); const r = await read(file, 16384);
    need(r.sha256 === initial.sha256 && same(r.stat, initial.stat) && r.value.token === secret && r.value.sourceKey === sourceKey, "KEYWORD_INCREMENTAL_LOCK_CHANGED");
    await fs.unlink(file); await syncDir(directory); released = true;
  } });
}
async function gzipJson(file, storedBound, rawBound, expectedStored, expectedRaw, decodeJson = true) {
  const r = await read(file, storedBound, true); if (expectedStored) need(r.sha256 === expectedStored);
  const raw = zlib.gunzipSync(r.bytes, { maxOutputLength: rawBound }); if (expectedRaw) need(hash(raw) === expectedRaw);
  return { value: decodeJson ? JSON.parse(raw) : null, sha256: r.sha256, rawSha256: hash(raw), rawBytes: raw.length };
}
async function queueSnapshot(dataDir) {
  const dir = path.join(dataDir, "keyword_monthly_refresh/jobs"), before = await checked(dir, true); const entries = await fs.readdir(dir, { withFileTypes: true }); need(entries.length <= 4096);
  const pins = []; let total = 0;
  for (const e of entries) { need(e.isFile() && /^[a-f0-9]{64}\.json$/.test(e.name)); const r = await read(path.join(dir, e.name), 8192); total += r.bytes.length; need(total <= 8 * 1024 ** 2);
    need(r.value.jobId === e.name.slice(0, -5) && r.value.status !== "running"
      && !(VERSIONS.has(r.value.intent?.refreshVersion) && ["queued", "deferred"].includes(r.value.status)), "KEYWORD_INCREMENTAL_LOCK_QUEUE_ACTIVE"); pins.push([e.name, r.sha256]); }
  need(same(before, await checked(dir, true)), "KEYWORD_INCREMENTAL_LOCK_QUEUE_CHANGED");
  return hash(jsonBytes(pins.sort((a, b) => a[0].localeCompare(b[0]))));
}
async function collectionSnapshot(dataDir) {
  const pins = [], day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  for (const [rel, max, broker] of [["collector/jobs.json", 16 * 1024 ** 2, true], ["collector-scheduled/jobs.json", 16 * 1024 ** 2, true], ["collector-web/state.json", 1024 ** 2, false]]) {
    const r = await read(path.join(dataDir, rel), max), v = r.value;
    need(v?.version === 1 && Object.hasOwn(v, "halted") && v.halted === null, "KEYWORD_INCREMENTAL_LOCK_COLLECTION_PROTECTED");
    if (v.reviewHold !== null && v.reviewHold !== undefined) need(typeof v.reviewHold.holdThrough === "string" && /^20\d\d-\d\d-\d\d$/.test(v.reviewHold.holdThrough)
      && Number.isFinite(Date.parse(v.reviewHold.holdThrough + "T00:00:00Z")) && new Date(v.reviewHold.holdThrough + "T00:00:00Z").toISOString().slice(0, 10) === v.reviewHold.holdThrough
      && v.reviewHold.holdThrough < day, "KEYWORD_INCREMENTAL_LOCK_COLLECTION_PROTECTED");
    if (broker) { need(Array.isArray(v.jobs), "KEYWORD_INCREMENTAL_LOCK_COLLECTION_UNKNOWN");
      for (const j of v.jobs) need(["completed", "failed", "cancelled", "interrupted"].includes(j.status) && !(j.leaseHash && !j.leaseReleasedAt), "KEYWORD_INCREMENTAL_LOCK_COLLECTION_BUSY");
    } else need(Object.hasOwn(v, "active") && v.active === null, "KEYWORD_INCREMENTAL_LOCK_COLLECTION_BUSY");
    pins.push([rel, r.sha256]);
  }
  const post = await read(path.join(dataDir, "history/collection_postprocess/queue.json"), 2 * 1024 ** 2);
  need(post.value?.version === 1 && post.value.jobs && typeof post.value.jobs === "object" && !Array.isArray(post.value.jobs), "KEYWORD_INCREMENTAL_LOCK_DB_UNKNOWN");
  for (const j of Object.values(post.value.jobs)) need(["held", "complete", "failed"].includes(j.status), "KEYWORD_INCREMENTAL_LOCK_DB_BUSY");
  pins.push(["history/collection_postprocess/queue.json", post.sha256]); return hash(jsonBytes(pins));
}
async function serverChain(proc, pid) {
  const rows = [], seen = new Set(); let expectedCwd;
  for (let n = 0; n < 16; n++) {
    const p = await proc.process(pid); need(p && !seen.has(pid) && /^\d+$/.test(p.startTicks) && SHA.test(p.executableIdentity || "") && SHA.test(p.cwdIdentity || ""), "KEYWORD_INCREMENTAL_LOCK_SERVER_UNKNOWN");
    need(n === 0 ? p.kind === "node" : ["node", "shell"].includes(p.kind), "KEYWORD_INCREMENTAL_LOCK_SERVER_UNKNOWN");
    if (n === 0) expectedCwd = p.cwdIdentity; else if (pid !== 1) need(p.cwdIdentity === expectedCwd, "KEYWORD_INCREMENTAL_LOCK_SERVER_UNKNOWN");
    rows.push({ pid, ppid: p.ppid, startTicks: p.startTicks, kind: p.kind, executableIdentity: p.executableIdentity, cwdIdentity: p.cwdIdentity }); seen.add(pid);
    if (pid === 1) return rows; need(Number.isSafeInteger(p.ppid) && p.ppid > 0 && p.ppid !== pid, "KEYWORD_INCREMENTAL_LOCK_SERVER_UNKNOWN"); pid = p.ppid;
  }
  throw fault("KEYWORD_INCREMENTAL_LOCK_SERVER_UNKNOWN");
}
function ownerIdentity(p) { return p && { pid: p.pid, ppid: p.ppid, startTicks: p.startTicks, kind: p.kind, executableIdentity: p.executableIdentity, cwdIdentity: p.cwdIdentity }; }
function contextFingerprint(value) {
  need(value && UUID.test(value.bootId || "") && /^pid:\[\d+\]$/.test(value.pidNamespace || "") && SHA.test(value.hostId || ""), "KEYWORD_INCREMENTAL_LOCK_CONTEXT_UNKNOWN");
  return hash(jsonBytes([value.bootId, value.pidNamespace, value.hostId]));
}
function retiredInstanceEvidence(proof, lock, lockSha256, currentContext, now = Date.now()) {
  // This is an explicit operator-reviewed provider/disk handover proof. A local
  // missing/reused PID or an old timestamp can never establish remote death.
  const fields = ["schemaVersion", "action", "serviceId", "persistentDiskMount", "priorDeploymentId", "priorDeploymentStartedAt", "retirementNoLaterThan", "retirementBoundBasis", "currentDeploymentId", "currentInstanceStartedAt", "reviewedAt", "lockSha256", "ownerContextSha256", "currentContextSha256", "providerEvidenceSha256", "diskExclusivityEvidenceSha256", "priorInstanceTerminationBoundVerified", "exclusiveDiskHandoverVerified", "priorInstanceHostname", "priorHostnameEvidenceSha256"];
  need(proof && Object.keys(proof).length === fields.length && fields.every(k => Object.hasOwn(proof, k)) && proof.schemaVersion === 1
    && proof.action === "reviewed_retired_instance_worker_lock" && proof.serviceId === CENTRAL_SERVICE && proof.persistentDiskMount === "/var/data"
    && /^dep-[a-z0-9]{10,80}$/.test(proof.priorDeploymentId || "") && /^dep-[a-z0-9]{10,80}$/.test(proof.currentDeploymentId || "")
    && proof.priorDeploymentId !== proof.currentDeploymentId && proof.priorInstanceTerminationBoundVerified === true && proof.exclusiveDiskHandoverVerified === true
    && /^srv-da9q6don74is738t7id0-[a-z0-9]{4,80}-[a-z0-9]{3,30}$/.test(proof.priorInstanceHostname || "")
    && proof.retirementBoundBasis === "exclusive_persistent_disk_handover"
    && ["priorDeploymentStartedAt", "retirementNoLaterThan", "currentInstanceStartedAt", "reviewedAt"].every(k => iso(proof[k]))
    && ["lockSha256", "ownerContextSha256", "currentContextSha256", "providerEvidenceSha256", "diskExclusivityEvidenceSha256", "priorHostnameEvidenceSha256"].every(k => SHA.test(proof[k] || "")), "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_REQUIRED");
  const nowMs = new Date(now).getTime();
  need(lock.schemaVersion === 2 && proof.lockSha256 === lockSha256 && proof.ownerContextSha256 === contextFingerprint(lock.owner)
    && proof.currentContextSha256 === contextFingerprint(currentContext) && proof.ownerContextSha256 !== proof.currentContextSha256
    && hash(jsonBytes([proof.priorInstanceHostname, lock.owner.bootId])) === lock.owner.hostId
    && Date.parse(proof.priorDeploymentStartedAt) <= Date.parse(lock.createdAt) && Date.parse(lock.createdAt) <= Date.parse(proof.retirementNoLaterThan)
    && Date.parse(proof.retirementNoLaterThan) <= Date.parse(proof.currentInstanceStartedAt) && Date.parse(proof.currentInstanceStartedAt) <= Date.parse(proof.reviewedAt)
    && Number.isFinite(nowMs) && Date.parse(proof.reviewedAt) <= nowMs + 5000, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_MISMATCH");
  return { proofSha256: hash(jsonBytes(proof)), providerEvidenceSha256: proof.providerEvidenceSha256, diskExclusivityEvidenceSha256: proof.diskExclusivityEvidenceSha256,
    priorHostnameBindingSha256: hash(jsonBytes([proof.priorHostnameEvidenceSha256, hash(Buffer.from(proof.priorInstanceHostname)), lock.owner.hostId])),
    priorDeploymentId: proof.priorDeploymentId, currentDeploymentId: proof.currentDeploymentId, retirementNoLaterThan: proof.retirementNoLaterThan, retirementBoundBasis: proof.retirementBoundBasis,
    currentInstanceStartedAt: proof.currentInstanceStartedAt, currentContextSha256: proof.currentContextSha256 };
}
async function inspectWorkerLockInstanceContext(options) {
  need(path.isAbsolute(options.dataDir) && (options.fixture === true || options.dataDir === "/var/data"));
  const directory = path.join(options.dataDir, "keyword_monthly_incremental"), r = await read(path.join(directory, LOCK), 16384), l = r.value;
  need(l.schemaVersion === 2 && UUID.test(l.token || "") && UUID.test(l.jobId || "") && SHA.test(l.sourceKey || "") && VERSIONS.has(l.version)
    && iso(l.createdAt) && /^\d+$/.test(l.owner?.startTicks || ""), "KEYWORD_INCREMENTAL_LOCK_CONTEXT_UNKNOWN");
  const ownerContextSha256 = contextFingerprint(l.owner), proc = reader(options), currentContext = await proc.context(), currentContextSha256 = contextFingerprint(currentContext);
  const fresh = await read(r.file, 16384); need(fresh.sha256 === r.sha256 && same(fresh.stat, r.stat) && contextFingerprint(await proc.context()) === currentContextSha256, "KEYWORD_INCREMENTAL_LOCK_CHANGED");
  return { schemaVersion: 1, status: ownerContextSha256 === currentContextSha256 ? "same_instance" : "retirement_evidence_required", lockSha256: r.sha256,
    sourceKey: l.sourceKey, lockJobId: l.jobId, version: l.version, createdAt: l.createdAt, ownerContextSha256, currentContextSha256,
    expectedServiceId: CENTRAL_SERVICE, expectedDiskMount: "/var/data", providerRetirementVerified: false, changed: false };
}
async function inspectWorkerLockProviderPeers(options) {
  need(path.isAbsolute(options.dataDir) && (options.fixture === true || options.dataDir === "/var/data") && SHA.test(options.targetJobId || "") && Number.isSafeInteger(options.serverPid) && options.serverPid > 0);
  const lock = await read(path.join(options.dataDir, "keyword_monthly_incremental", LOCK), 16384), proc = createLinuxProcessReader();
  const result = await require("./keyword_monthly_provider_peer.cjs").inspectProviderPeerCandidates({ readContext: proc.context, readServer: proc.process, serverPid: options.serverPid });
  const fresh = await read(lock.file, 16384); need(fresh.sha256 === lock.sha256 && same(fresh.stat, lock.stat), "KEYWORD_INCREMENTAL_LOCK_CHANGED");
  return { ...result, serviceId: CENTRAL_SERVICE, targetJobId: options.targetJobId, lockSha256: lock.sha256 };
}
async function legacyReuseCandidate(proc, owner, chain) {
  const current = chain.find(p => p.pid === owner.pid);
  need(current && JSON.stringify(ownerIdentity(owner)) === JSON.stringify(current), "KEYWORD_INCREMENTAL_LOCK_OWNER_ACTIVE");
  need(typeof proc.clockBasis === "function", "KEYWORD_INCREMENTAL_LOCK_BIRTH_PROOF_UNKNOWN"); const c = await proc.clockBasis(owner.startTicks);
  need(c && /^\d+$/.test(c.bootEpochSeconds || "") && /^[1-9]\d{0,5}$/.test(c.ticksPerSecond || "") && c.coherenceVerified === true
    && /^time:\[\d+\]$/.test(c.timeNamespace || "") && owner.timeNamespace === c.timeNamespace
    && SHA.test(c.getconfSha256 || "") && c.getconfIdentity && typeof c.getconfIdentity === "object", "KEYWORD_INCREMENTAL_LOCK_BIRTH_PROOF_UNKNOWN");
  const ticks = BigInt(owner.startTicks), hz = BigInt(c.ticksPerSecond), base = BigInt(c.bootEpochSeconds) * 1000n;
  // btime is whole seconds and starttime is whole CLK_TCK units. The fixed
  // two-second margin is conservative clock quantization, not lock age/TTL.
  const lower = base + ticks * 1000n / hz - 2000n, upper = base + (ticks * 1000n + hz - 1n) / hz + 2000n;
  need(lower > 0n && upper <= BigInt(Number.MAX_SAFE_INTEGER), "KEYWORD_INCREMENTAL_LOCK_BIRTH_PROOF_UNKNOWN");
  return { ...ownerIdentity(owner), currentKind: owner.kind, oldOwnerRuntimeContract: "node_host_worker", bootEpochSeconds: c.bootEpochSeconds,
    ticksPerSecond: c.ticksPerSecond, timeNamespace: c.timeNamespace, getconfSha256: c.getconfSha256, getconfIdentity: c.getconfIdentity,
    currentBirthLowerEpochMs: Number(lower), currentBirthUpperEpochMs: Number(upper) };
}
async function ownerStillMatches(proc, pid, candidate, retiredInstance) {
  if (retiredInstance) { try { return contextFingerprint(await proc.context()) === retiredInstance.currentContextSha256; } catch { return false; } }
  const p = await proc.process(pid); if (!candidate) return !p;
  if (!p || JSON.stringify(ownerIdentity(p)) !== JSON.stringify(ownerIdentity(candidate))) return false;
  try { return JSON.stringify(await legacyReuseCandidate(proc, p, [ownerIdentity(p)])) === JSON.stringify(candidate); } catch { return false; }
}
async function inspectInternal(options) {
  const { dataDir, targetJobId, serverPid } = options; need(path.isAbsolute(dataDir) && SHA.test(targetJobId || "") && Number.isSafeInteger(serverPid) && serverPid > 0);
  const directory = path.join(dataDir, "keyword_monthly_incremental"), namespace = await checked(directory, true), r = await read(path.join(directory, LOCK), 16384), l = r.value;
  need(options.fixture === true && process.platform === "win32" || (namespace.mode & 0o777n) === 0o700n && namespace.uid === BigInt(process.getuid()));
  need((l.schemaVersion === 1 || l.schemaVersion === 2) && UUID.test(l.token || "") && SHA.test(l.sourceKey || "") && Number.isSafeInteger(l.pid) && l.pid > 0 && iso(l.createdAt));
  need(options.fixture === true && process.platform === "win32" || (r.stat.mode & 0o777n) === 0o600n && r.stat.uid === BigInt(process.getuid()), "KEYWORD_INCREMENTAL_LOCK_MODE_UNSAFE");
  const q = await read(path.join(dataDir, "keyword_monthly_refresh/jobs", targetJobId + ".json"), 8192), i = q.value.intent;
  need(q.value.jobId === targetJobId && i && VERSIONS.has(i.refreshVersion) && q.value.status === "needs_verification");
  need(hash(jsonBytes([i.refreshVersion, i.runId, i.manifestSha256, i.keyword, i.scope, i.scheduleOccurrenceId])) === targetJobId);
  need(hash(jsonBytes([i.refreshVersion, i.runId, i.manifestSha256, i.keyword])) === l.sourceKey, "KEYWORD_INCREMENTAL_LOCK_SOURCE_MISMATCH");
  const proc = reader({ ...options, expectedLockSha256: r.sha256 }), context = await proc.context(); let retiredInstance = null;
  if (l.schemaVersion === 2) {
    need(l.version === i.refreshVersion && l.owner && /^\d+$/.test(l.owner.startTicks || ""), "KEYWORD_INCREMENTAL_LOCK_CONTEXT_UNKNOWN");
    const sameContext = contextFingerprint(l.owner) === contextFingerprint(context);
    if (!sameContext) {
      need(options.retiredInstanceProof, "KEYWORD_INCREMENTAL_LOCK_CONTEXT_UNKNOWN");
      need(options.fixture === true || dataDir === "/var/data", "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_MISMATCH");
      retiredInstance = retiredInstanceEvidence(options.retiredInstanceProof, l, r.sha256, context, typeof options.now === "function" ? options.now() : Date.now());
    } else need(!options.retiredInstanceProof, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_NOT_APPLICABLE");
  } else need(!options.retiredInstanceProof, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_NOT_APPLICABLE");
  // Old PID numbers belong to the retired namespace. Never interpret a new
  // instance's colliding owner/child PID as evidence about that old instance.
  const owner = retiredInstance ? null : await proc.process(l.pid);
  if (owner && l.schemaVersion === 2) throw fault(owner.startTicks !== l.owner.startTicks ? "KEYWORD_INCREMENTAL_LOCK_PID_REUSED" : "KEYWORD_INCREMENTAL_LOCK_OWNER_ACTIVE");
  const chain = await serverChain(proc, serverPid), excluded = [process.pid, ...chain.map(p => p.pid)];
  const ownerReuse = owner ? await legacyReuseCandidate(proc, owner, chain) : null;
  if (!ownerReuse && !retiredInstance) need(!chain.some(p => p.pid === l.pid), "KEYWORD_INCREMENTAL_LOCK_SERVER_UNKNOWN");
  const jobId = l.schemaVersion === 1 ? l.token : l.jobId; need(UUID.test(jobId || "")); const jobRoot = path.join(directory, "jobs", "refresh-job-" + jobId);
  const ownerRecord = await read(path.join(jobRoot, "refresh-owner.json"), 16384); need(ownerRecord.value.token === jobId && ownerRecord.value.sourceKey === l.sourceKey && ownerRecord.value.root === jobRoot);
  const input = await read(path.join(jobRoot, "job-input.json"), 1024 * 1024); need(input.value.version === i.refreshVersion && input.value.dataDir === dataDir);
  const e = input.value.evidence; need(e && e.runId === i.runId && e.keyword === i.keyword && e.manifestSha256 === i.manifestSha256 && (e.scheduleOccurrenceId || null) === (i.scheduleOccurrenceId || null));
  need(/^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/.test(i.runId || "") && SHA.test(i.manifestSha256 || ""));
  const manifest = await read(path.join(dataDir, "outputs", i.runId, "manifest.json"), 1024 * 1024);
  need(manifest.sha256 === i.manifestSha256 && manifest.value.keyword === i.keyword && manifest.value.collectionQuality?.status === "complete", "KEYWORD_INCREMENTAL_LOCK_MANIFEST_CHANGED");
  const db = await read(path.join(dataDir, "history/collection_postprocess/runs", hash(Buffer.from(i.runId)) + ".json"), 128 * 1024);
  need(db.value.runId === i.runId && db.value.status === "complete" && db.value.result?.sourceManifestSha256 === i.manifestSha256
    && db.value.finishedAt === e.finishedAt && (db.value.scheduleOccurrenceId ?? db.value.context?.scheduleOccurrenceId ?? null) === (i.scheduleOccurrenceId || null), "KEYWORD_INCREMENTAL_LOCK_DB_CHANGED");
  const proof = await read(path.join(jobRoot, "control/isolation.json"), 65536), p = proof.value;
  need(p.expectedRoot === jobRoot && p.pid !== l.pid && p.pid !== serverPid && Number.isSafeInteger(p.pid) && p.pid > 0 && p.fixtureOnly !== true
    && p.mode === "seccomp" && p.noNewPrivs === true && p.seccompMode === 2 && p.networkFdsClosed === true && p.environmentSanitizedForExec === true
    && p.guardName === "reconstruct_keyword_monthly_incremental.cjs" && p.guardRequiredBeforeNormalization === true && p.applicationStarted === false
    && p.preflightOnly === false && p.providerCalls === 0
    && p.unrestrictedFallbackAllowed === false && SHA.test(p.guardSha256 || "") && SHA.test(p.nodeSha256 || "")
    && p.nonStandardFdsClosedBeforeExec === true && p.nonStandardFdsRemainingBeforeExec === 0
    && ["tcpSocketDenied", "udpSocketDenied", "ipv6SocketDenied"].every(k => p.kernelProbe?.[k] === true)
    && ["socket", "socketpair", "connect", "sendto", "sendmsg"].every(k => p.kernelProbe?.syscallsDeniedWithEperm?.[k] === true), "KEYWORD_INCREMENTAL_LOCK_CHILD_PROOF_INVALID");
  need(retiredInstance || !chain.some(x => x.pid === p.pid) && !await proc.process(p.pid), "KEYWORD_INCREMENTAL_LOCK_CHILD_ACTIVE"); need((await proc.peers(excluded)).length === 0, "KEYWORD_INCREMENTAL_LOCK_PEER_UNKNOWN");
  const receiptDir = path.join(dataDir, "keyword_monthly_analysis/refresh-receipts");
  need(await absent(path.join(receiptDir, "intent-" + l.sourceKey + ".json")), "KEYWORD_INCREMENTAL_LOCK_PUBLICATION_INTENT_PRESENT");
  need(await absent(path.join(receiptDir, "complete-" + l.sourceKey + ".json")), "KEYWORD_INCREMENTAL_LOCK_COMPLETION_REQUIRES_REVIEW");
  const preparation = await maybe(path.join(jobRoot, "preparation-complete.json"), 16 * 1024 ** 2);
  if (preparation) need(preparation.value.version === i.refreshVersion && preparation.value.status === "complete" && preparation.value.isolation?.pid === p.pid
    && preparation.value.isolation.proofSha256 === proof.sha256 && preparation.value.providerCalls === 0 && preparation.value.sourceWrites === 0 && preparation.value.appEntryExecutions === 0
    && preparation.value.kosisReadOrChanged === false && Object.values(preparation.value.guardMetrics || {}).length > 0 && Object.values(preparation.value.guardMetrics).every(v => v === 0), "KEYWORD_INCREMENTAL_LOCK_PREPARATION_INVALID");
  const source = await read(path.join(directory, "source-current.json"), 16384), s = source.value;
  need(s.schemaVersion === 1 && s.version === "keyword-monthly-incremental-state-v1" && s.compression === "gzip" && SHA.test(s.stateSha256 || "") && SHA.test(s.storageSha256 || "") && s.rawBytes <= MAX_STATE && s.storageBytes <= MAX_STATE);
  const state = await gzipJson(path.join(directory, "states", s.stateSha256 + ".json.gz"), MAX_STATE, MAX_STATE, s.storageSha256, s.stateSha256);
  need(state.rawBytes === s.rawBytes && state.value.version === s.version && state.value.schemaVersion === 1); const last = state.value.lastPublished;
  need(last && SHA.test(last.sourceKey || "") && SHA.test(last.stateSha256 || ""));
  const pubDir = path.join(dataDir, "keyword_monthly_analysis"), pub = await read(path.join(pubDir, "current.json"), 16384), b = pub.value;
  need(b.schemaVersion === 1 && /^[a-f0-9]{32}$/.test(b.generation || "") && SHA.test(b.catalogSha256 || "") && last.pointerSha256 === pub.sha256 && last.generation === b.generation, "KEYWORD_INCREMENTAL_LOCK_PUBLIC_POINTER_CONFLICT");
  const catalog = await read(path.join(pubDir, "generations", b.generation, "catalog.json"), 1024 * 1024); need(catalog.sha256 === b.catalogSha256 && catalog.bytes.length === b.catalogBytes);
  const published = await read(path.join(pubDir, "generations", b.generation, "publication-receipt.json"), 256 * 1024);
  const completed = await read(path.join(receiptDir, "complete-" + last.sourceKey + ".json"), 256 * 1024), c = completed.value;
  need(c.schemaVersion === 1 && c.generatedBy === "keyword_monthly_incremental_refresh" && c.mode === "live" && c.sourceKey === last.sourceKey
    && hash(jsonBytes([c.refreshVersion, c.runId, c.manifestSha256, c.keyword])) === last.sourceKey
    && c.status === "published" && c.fixtureOnly === false && c.strictIsolationVerified === true && c.incrementalValidated === true && VERSIONS.has(c.refreshVersion)
    && c.stateSha256 === last.stateSha256 && c.pointerSha256 === pub.sha256 && c.catalogSha256 === catalog.sha256 && c.generation === b.generation && c.publicationReceiptSha256 === published.sha256
    && c.providerCalls === 0 && c.sourceWrites === 0 && published.value.status === "published" && published.value.pointerSha256 === pub.sha256
    && published.value.catalogSha256 === catalog.sha256 && published.value.generation === b.generation, "KEYWORD_INCREMENTAL_LOCK_LAST_PUBLICATION_UNVERIFIED");
  need(SHA.test(c.preparationSha256 || "") && SHA.test(c.preparationEvidenceSha256 || ""));
  const retained = await gzipJson(path.join(receiptDir, "incremental-evidence-" + last.sourceKey + ".json.gz"), 16 * 1024 ** 2, 16 * 1024 ** 2, c.preparationEvidenceSha256, c.preparationSha256);
  need(retained.value.stateSha256 === c.stateSha256 && retained.value.version === c.refreshVersion && retained.value.status === "complete" && retained.value.providerCalls === 0 && retained.value.sourceWrites === 0);
  await gzipJson(path.join(directory, "states", c.stateSha256 + ".json.gz"), MAX_STATE, MAX_STATE, null, c.stateSha256, false);
  const queueSha256 = await queueSnapshot(dataDir), collectionSha256 = await collectionSnapshot(dataDir); need(JSON.stringify(await proc.context()) === JSON.stringify(context));
  need(JSON.stringify(await serverChain(proc, serverPid)) === JSON.stringify(chain) && await ownerStillMatches(proc, l.pid, ownerReuse, retiredInstance) && (retiredInstance || !await proc.process(p.pid))
    && (await proc.peers(excluded)).length === 0, "KEYWORD_INCREMENTAL_LOCK_PROCESS_CHANGED");
  const fresh = await read(r.file, 16384); need(fresh.sha256 === r.sha256 && same(fresh.stat, r.stat), "KEYWORD_INCREMENTAL_LOCK_CHANGED");
  const snapshot = { schemaVersion: 1, targetJobId, lockSha256: r.sha256, lockStat: smallStat(r.stat), lockSchemaVersion: l.schemaVersion, ownerPid: l.pid, sourceKey: l.sourceKey, createdAt: l.createdAt,
    processContext: context, serverChain: chain, ownerReuse, ...(retiredInstance ? { retiredInstance } : {}),
    ...(options.providerPeerProof ? { providerPeerProofSha256: hash(jsonBytes(options.providerPeerProof)) } : {}), childPid: p.pid, childProofSha256: proof.sha256,
    jobInputSha256: input.sha256, jobOwnerRecordSha256: ownerRecord.sha256, sourceManifestSha256: manifest.sha256, dbReceiptSha256: db.sha256,
    preparationSha256: preparation?.sha256 || null, sourcePointerSha256: source.sha256, sourceStateSha256: s.stateSha256,
    publicPointerSha256: pub.sha256, catalogSha256: catalog.sha256, publicationReceiptSha256: published.sha256, lastCompleteSha256: completed.sha256, queueSha256, collectionSha256 };
  return { snapshot, snapshotSha256: hash(jsonBytes(snapshot)), lock: r, directory, processes: proc };
}
async function inspectWorkerLockRecovery(options) { const r = await inspectInternal(options); return { status: r.snapshot.retiredInstance ? "retired_instance_review_required" : r.snapshot.ownerReuse ? "reuse_review_required" : "review_required", snapshot: r.snapshot, snapshotSha256: r.snapshotSha256, legacyIncidentRequired: r.snapshot.lockSchemaVersion === 1 }; }
function validateReview(proof, inspected) {
  need(proof && Object.keys(proof).every(k => ["schemaVersion", "action", "targetJobId", "snapshotSha256", "lockSha256", "sourcePointerSha256", "publicPointerSha256", "incident"].includes(k))
    && proof.schemaVersion === 1 && proof.action === "reviewed_dead_worker_lock_recovery" && proof.targetJobId === inspected.snapshot.targetJobId
    && proof.snapshotSha256 === inspected.snapshotSha256 && proof.lockSha256 === inspected.snapshot.lockSha256
    && proof.sourcePointerSha256 === inspected.snapshot.sourcePointerSha256 && proof.publicPointerSha256 === inspected.snapshot.publicPointerSha256, "KEYWORD_INCREMENTAL_LOCK_REVIEW_MISMATCH");
  const e = proof.incident;
  if (inspected.snapshot.retiredInstance) {
    need(e && Object.keys(e).length === 3 && Object.keys(e).every(k => ["kind", "retirementProofSha256", "evidenceSha256"].includes(k))
      && e.kind === "retired_instance" && e.retirementProofSha256 === inspected.snapshot.retiredInstance.proofSha256
      && e.evidenceSha256 === inspected.snapshot.retiredInstance.providerEvidenceSha256, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_MISMATCH"); return;
  }
  need(e && Object.keys(e).every(k => ["pid", "exitCode", "exitedAt", "evidenceSha256"].includes(k)) && e.pid === inspected.snapshot.ownerPid
    && Number.isSafeInteger(e.exitCode) && e.exitCode > 0 && e.exitCode <= 255 && iso(e.exitedAt) && SHA.test(e.evidenceSha256 || "")
    && Date.parse(e.exitedAt) >= Date.parse(inspected.snapshot.createdAt), "KEYWORD_INCREMENTAL_LOCK_EXIT_EVIDENCE_REQUIRED");
  if (inspected.snapshot.ownerReuse) need(inspected.snapshot.lockSchemaVersion === 1 && e.exitCode === 134
    && Date.parse(e.exitedAt) < inspected.snapshot.ownerReuse.currentBirthLowerEpochMs, "KEYWORD_INCREMENTAL_LOCK_PID_REUSE_EXIT_UNPROVEN");
}
async function recoverWorkerLock(options) {
  const inspected = await inspectInternal(options); validateReview(options.reviewedProof, inspected);
  if (options.dryRun !== false) return { status: "verified_dry_run", snapshotSha256: inspected.snapshotSha256, lockSha256: inspected.snapshot.lockSha256, changed: false };
  const claimFile = path.join(inspected.directory, CLAIM), id = crypto.randomUUID(); let claim;
  try { claim = await writeNew(claimFile, { schemaVersion: 1, recoveryId: id, pid: process.pid, snapshotSha256: inspected.snapshotSha256, createdAt: new Date().toISOString() }); }
  catch (e) { if (e.code === "EEXIST") throw fault("KEYWORD_INCREMENTAL_LOCK_RECOVERY_IN_PROGRESS"); throw e; }
  let archive = null, completed = false;
  try {
    const current = await inspectInternal(options); need(current.snapshotSha256 === inspected.snapshotSha256, "KEYWORD_INCREMENTAL_LOCK_REVIEW_MISMATCH");
    const root = path.join(current.directory, "lock-recovery"); await privateDir(root, options.fixture === true); const destination = path.join(root, id); await fs.mkdir(destination, { mode: 0o700 });
    const destinationStat = await checked(destination, true); need(options.fixture === true && process.platform === "win32" || (destinationStat.mode & 0o777n) === 0o700n && destinationStat.uid === BigInt(process.getuid()));
    const planned = await writeNew(path.join(destination, "reviewed-preflight.json"), { schemaVersion: 1, action: "reviewed_dead_worker_lock_recovery", recoveryId: id,
      snapshot: current.snapshot, snapshotSha256: current.snapshotSha256, reviewedProofSha256: hash(jsonBytes(options.reviewedProof)), incident: options.reviewedProof.incident, observedAt: new Date().toISOString() });
    archive = path.join(destination, "original-lock.json"); need(await absent(archive)); const before = await read(current.lock.file, 16384);
    need(before.sha256 === current.lock.sha256 && same(before.stat, current.lock.stat), "KEYWORD_INCREMENTAL_LOCK_CHANGED");
    need(JSON.stringify(await serverChain(current.processes, options.serverPid)) === JSON.stringify(current.snapshot.serverChain)
      && await ownerStillMatches(current.processes, current.snapshot.ownerPid, current.snapshot.ownerReuse, current.snapshot.retiredInstance) && (current.snapshot.retiredInstance || !await current.processes.process(current.snapshot.childPid))
      && (await current.processes.peers([process.pid, ...current.snapshot.serverChain.map(p => p.pid)])).length === 0, "KEYWORD_INCREMENTAL_LOCK_PROCESS_CHANGED");
    need((await read(path.join(current.directory, "source-current.json"), 16384)).sha256 === current.snapshot.sourcePointerSha256
      && (await read(path.join(options.dataDir, "keyword_monthly_analysis/current.json"), 16384)).sha256 === current.snapshot.publicPointerSha256
      && await queueSnapshot(options.dataDir) === current.snapshot.queueSha256 && await collectionSnapshot(options.dataDir) === current.snapshot.collectionSha256, "KEYWORD_INCREMENTAL_LOCK_REVIEW_MISMATCH");
    const finalLock = await read(current.lock.file, 16384); need(finalLock.sha256 === before.sha256 && same(finalLock.stat, before.stat), "KEYWORD_INCREMENTAL_LOCK_CHANGED");
    let atomicArchive;
    if (options.archiveNoReplace) { need(options.fixture === true); await options.archiveNoReplace(current.lock.file, archive); atomicArchive = { fixtureOnly: true }; }
    else atomicArchive = await archiveNoReplace(current.lock.file, archive, options.fixture);
    await syncDir(current.directory); await syncDir(destination);
    const preserved = await read(archive, 16384); need(preserved.sha256 === before.sha256 && preserved.stat.dev === before.stat.dev && preserved.stat.ino === before.stat.ino && preserved.stat.mode === before.stat.mode, "KEYWORD_INCREMENTAL_LOCK_ARCHIVE_CHANGED");
    need(await absent(current.lock.file), "KEYWORD_INCREMENTAL_LOCK_NEW_OWNER_PRESENT");
    need((await read(path.join(current.directory, "source-current.json"), 16384)).sha256 === current.snapshot.sourcePointerSha256
      && (await read(path.join(options.dataDir, "keyword_monthly_analysis/current.json"), 16384)).sha256 === current.snapshot.publicPointerSha256
      && await queueSnapshot(options.dataDir) === current.snapshot.queueSha256 && await collectionSnapshot(options.dataDir) === current.snapshot.collectionSha256
      && JSON.stringify(await serverChain(current.processes, options.serverPid)) === JSON.stringify(current.snapshot.serverChain)
      && await ownerStillMatches(current.processes, current.snapshot.ownerPid, current.snapshot.ownerReuse, current.snapshot.retiredInstance) && (current.snapshot.retiredInstance || !await current.processes.process(current.snapshot.childPid))
      && (await current.processes.peers([process.pid, ...current.snapshot.serverChain.map(p => p.pid)])).length === 0, "KEYWORD_INCREMENTAL_LOCK_POST_ARCHIVE_HOLD");
    const receipt = await writeNew(path.join(destination, "recovery-complete.json"), { schemaVersion: 1, recoveryId: id, action: "archived_verified_dead_worker_lock", lockSha256: preserved.sha256,
      snapshotSha256: current.snapshotSha256, preflightSha256: planned.sha256, sourcePointerSha256: current.snapshot.sourcePointerSha256, publicPointerSha256: current.snapshot.publicPointerSha256,
      atomicArchive, ...(current.snapshot.retiredInstance ? { retiredInstance: current.snapshot.retiredInstance } : {}),
      ...(current.snapshot.providerPeerProofSha256 ? { providerPeerProofSha256: current.snapshot.providerPeerProofSha256 } : {}), originalBytesAndModePreserved: true, originalLedgersChanged: false, activeLockPathAbsent: true, completedAt: new Date().toISOString() });
    completed = true; return { status: "recovered", recoveryId: id, receiptSha256: receipt.sha256, lockSha256: preserved.sha256, originalBytesAndModePreserved: true, activeLockPathAbsent: receipt.value.activeLockPathAbsent };
  } finally {
    // An incomplete/ambiguous recovery leaves its claim and immutable evidence.
    // Another process must never infer permission to clear it from its age.
    if (completed || !archive) { const own = await read(claimFile, 65536); need(own.sha256 === claim.sha256); await fs.unlink(claimFile); await syncDir(inspected.directory); }
  }
}
async function cli(argv) {
  const flags = new Map(); for (let n = 0; n < argv.length; n++) { const k = argv[n]; need(["--inspect-context", "--inspect-provider-peers", "--inspect", "--dry-run", "--commit", "--job-id", "--server-pid", "--reviewed-proof", "--proof-sha", "--retired-instance-proof", "--retired-instance-proof-sha", "--provider-peer-proof", "--provider-peer-proof-sha"].includes(k) && !flags.has(k)); flags.set(k, ["--inspect-context", "--inspect-provider-peers", "--inspect", "--dry-run", "--commit"].includes(k) ? true : argv[++n]); }
  need(["--inspect-context", "--inspect-provider-peers", "--inspect", "--dry-run", "--commit"].filter(k => flags.has(k)).length === 1); const dataDir = "/var/data", base = { dataDir, targetJobId: flags.get("--job-id"), serverPid: Number(flags.get("--server-pid")) };
  if (flags.has("--inspect-context")) { need(flags.size === 1); return inspectWorkerLockInstanceContext(base); }
  if (flags.has("--inspect-provider-peers")) { need(flags.size === 3 && flags.has("--job-id") && flags.has("--server-pid")); return inspectWorkerLockProviderPeers(base); }
  if (flags.has("--provider-peer-proof") || flags.has("--provider-peer-proof-sha")) {
    const file = flags.get("--provider-peer-proof"); need(typeof file === "string" && path.isAbsolute(file) && inside(path.join(dataDir, "operations"), file) && SHA.test(flags.get("--provider-peer-proof-sha") || ""));
    const proof = await read(file, 65536); need(proof.value && typeof proof.value === "object" && !Array.isArray(proof.value) && proof.sha256 === flags.get("--provider-peer-proof-sha") && (proof.stat.mode & 0o777n) === 0o600n && proof.stat.uid === BigInt(process.getuid())); base.providerPeerProof = proof.value;
  }
  if (flags.has("--retired-instance-proof") || flags.has("--retired-instance-proof-sha")) {
    const file = flags.get("--retired-instance-proof"); need(typeof file === "string" && path.isAbsolute(file) && inside(path.join(dataDir, "operations"), file) && SHA.test(flags.get("--retired-instance-proof-sha") || ""));
    const proof = await read(file, 65536); need(proof.sha256 === flags.get("--retired-instance-proof-sha") && (proof.stat.mode & 0o777n) === 0o600n && proof.stat.uid === BigInt(process.getuid())); base.retiredInstanceProof = proof.value;
  }
  if (flags.has("--inspect")) { need(!flags.has("--reviewed-proof") && !flags.has("--proof-sha")); return inspectWorkerLockRecovery(base); }
  const file = flags.get("--reviewed-proof"); need(typeof file === "string" && path.isAbsolute(file) && inside(path.join(dataDir, "operations"), file) && SHA.test(flags.get("--proof-sha") || ""));
  const p = await read(file, 65536); need(p.sha256 === flags.get("--proof-sha") && (p.stat.mode & 0o777n) === 0o600n);
  return recoverWorkerLock({ ...base, reviewedProof: p.value, dryRun: !flags.has("--commit") });
}
if (require.main === module) cli(process.argv.slice(2)).then(r => process.stdout.write(JSON.stringify(r) + "\n")).catch(e => { process.stdout.write(JSON.stringify({ status: "hold", code: /^KEYWORD_INCREMENTAL_[A-Z0-9_]{1,120}$/.test(e.code || "") ? e.code : "KEYWORD_INCREMENTAL_LOCK_RECOVERY_HOLD" }) + "\n"); process.exitCode = 1; });
module.exports = { acquireWorkerLock, inspectWorkerLockRecovery, inspectWorkerLockInstanceContext, inspectWorkerLockProviderPeers, recoverWorkerLock, createLinuxProcessReader, ATOMIC_ARCHIVE_PROGRAM };
