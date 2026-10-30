"use strict";

// Independent, single-writer derived refresh journal. It never starts a collector,
// reads provider credentials, edits collection receipts or changes protection.
// The injected refresh callback owns atomic/idempotent bundle publication.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const SHA = /^[a-f0-9]{64}$/, RUN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/;
const STATES = new Set(["queued", "deferred", "running", "complete", "needs_verification"]);
const RECORD_BYTES = 8192, VERSION = "keyword-monthly-refresh-v1";
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const hash = v => crypto.createHash("sha256").update(v).digest("hex");
const fault = code => Object.assign(new Error(code), { code });
const need = (v, code) => { if (!v) throw fault(code); };
const text = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max && v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v);
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const same = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].every(k => a[k] === b[k]);
const clone = v => JSON.parse(JSON.stringify(v));
const safeCode = error => /^[A-Z][A-Z0-9_]{1,119}$/.test(error?.code || "") ? error.code : "KEYWORD_REFRESH_UNAVAILABLE";
const iso = v => typeof v === "string" && /^20\d\d-\d\d-\d\dT.*Z$/.test(v) && Number.isFinite(Date.parse(v));
const integer = (v, fallback, min, max) => { v ??= fallback; if (!Number.isSafeInteger(v) || v < min || v > max) throw TypeError("Invalid refresh bound"); return v; };

function createKeywordMonthlyRefresh(options = {}) {
  const { dataDir, readCompletedEvidence, refresh, canProcess = async () => true, now = () => new Date(),
    setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, fileSystem = fs } = options;
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir) || typeof readCompletedEvidence !== "function" || typeof refresh !== "function"
    || typeof canProcess !== "function" || typeof now !== "function" || typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") throw TypeError("Refresh requires an absolute dataDir and callbacks");
  const refreshVersion = options.refreshVersion ?? VERSION;
  if (!text(refreshVersion, 100) || !/^[A-Za-z0-9_.-]+$/.test(refreshVersion)) throw TypeError("Invalid refresh version");
  const maxRecords = integer(options.maxRecords, 2048, 1, 4096), maxPending = integer(options.maxPending, Math.min(128, maxRecords), 1, maxRecords);
  const maxAttempts = integer(options.maxAttempts, 3, 1, 10), idleIntervalMs = integer(options.idleIntervalMs, 2000, 1, 60000);
  const retryBaseMs = integer(options.retryBaseMs, 30000, 1, 3600000), retryMaxMs = integer(options.retryMaxMs, 300000, retryBaseMs, 86400000);
  const maxJournalBytes = integer(options.maxJournalBytes, 8 * 1024 * 1024, RECORD_BYTES, 32 * 1024 * 1024);
  const root = path.resolve(dataDir), directory = path.join(root, "keyword_monthly_refresh"), recordsDirectory = path.join(directory, "jobs");
  let initialized = false, initializing, serial = Promise.resolve(), workerPromise, timer, started = false, closed = false;
  let activeJobId = null, controller = null, storeError = null, lastEnqueueError = null, lastWorkerError = null, journalBytes = 0, activatedAt = null;
  const records = new Map(), deferredUntil = new Map();
  const stamp = () => { const value = new Date(now()); need(Number.isFinite(value.getTime()), "KEYWORD_REFRESH_CLOCK_INVALID"); return value.toISOString(); };
  const locked = work => { const result = serial.then(work); serial = result.catch(() => {}); return result; };
  const fileFor = id => path.join(recordsDirectory, id + ".json");

  async function checked(file, directoryExpected = false) {
    need(path.isAbsolute(file) && samePath(path.resolve(file), file), "KEYWORD_REFRESH_UNSAFE_PATH");
    let part = path.parse(file).root;
    for (const segment of file.slice(part.length).split(path.sep).filter(Boolean)) {
      part = path.join(part, segment); const s = await fileSystem.lstat(part);
      need(!s.isSymbolicLink() && (part === file || s.isDirectory()) && samePath(await fileSystem.realpath(part), part), "KEYWORD_REFRESH_UNSAFE_PATH");
    }
    const s = await fileSystem.lstat(file);
    need(directoryExpected ? s.isDirectory() : s.isFile() && s.nlink === 1, "KEYWORD_REFRESH_UNSAFE_PATH"); return s;
  }
  async function read(file) {
    const before = await checked(file); need(before.size > 0 && before.size <= RECORD_BYTES, "KEYWORD_REFRESH_RECORD_BOUND");
    const h = await fileSystem.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0));
    try {
      need(same(before, await h.stat()), "KEYWORD_REFRESH_EVIDENCE_CHANGED");
      const b = Buffer.alloc(before.size + 1); let n = 0;
      while (n < b.length) { const r = await h.read(b, n, b.length - n, n); if (!r.bytesRead) break; n += r.bytesRead; }
      need(n === before.size && same(before, await h.stat()) && same(before, await checked(file)), "KEYWORD_REFRESH_EVIDENCE_CHANGED");
      return { value: JSON.parse(b.subarray(0, n)), bytes: n };
    } finally { await h.close(); }
  }
  function intentFor(input) {
    need(plain(input) && Object.keys(input).every(k => ["runId", "keyword", "manifestSha256", "scheduleOccurrenceId", "scope"].includes(k)), "KEYWORD_REFRESH_INTENT_INVALID");
    need(RUN.test(input.runId || "") && text(input.keyword, 300) && SHA.test(input.manifestSha256 || ""), "KEYWORD_REFRESH_INTENT_INVALID");
    need(input.scheduleOccurrenceId == null || text(input.scheduleOccurrenceId, 240) && RUN.test(input.scheduleOccurrenceId), "KEYWORD_REFRESH_INTENT_INVALID");
    need(input.scope === undefined || text(input.scope, 300), "KEYWORD_REFRESH_INTENT_INVALID");
    return { runId: input.runId, keyword: input.keyword, manifestSha256: input.manifestSha256,
      scheduleOccurrenceId: input.scheduleOccurrenceId ?? null, scope: input.scope ?? input.keyword, refreshVersion };
  }
  const idFor = intent => hash(JSON.stringify([intent.refreshVersion, intent.runId, intent.manifestSha256, intent.keyword, intent.scope, intent.scheduleOccurrenceId]));
  function publicRow(row) {
    return clone(Object.fromEntries(["jobId", "intent", "status", "reasonCode", "createdAt", "updatedAt", "startedAt", "finishedAt", "nextAttemptAt", "recoveredAt", "attempts", "maxAttempts", "result"].filter(k => Object.hasOwn(row, k)).map(k => [k, row[k]])));
  }
  function validate(row, id) {
    need(plain(row) && row.schemaVersion === 1 && row.jobId === id && SHA.test(id) && STATES.has(row.status), "KEYWORD_REFRESH_RECORD_INVALID");
    need(plain(row.intent) && text(row.intent.refreshVersion, 100), "KEYWORD_REFRESH_RECORD_INVALID");
    const { refreshVersion: version, ...input } = row.intent, normalized = intentFor(input);
    normalized.refreshVersion = version;
    need(JSON.stringify(normalized) === JSON.stringify(row.intent) && idFor(row.intent) === id, "KEYWORD_REFRESH_RECORD_INVALID");
    need(iso(row.createdAt) && iso(row.updatedAt) && ["startedAt", "finishedAt", "nextAttemptAt", "recoveredAt"].every(k => row[k] === null || iso(row[k]))
      && Number.isSafeInteger(row.attempts) && row.attempts >= 0 && Number.isSafeInteger(row.maxAttempts) && row.maxAttempts >= 1 && row.maxAttempts <= 10 && row.attempts <= row.maxAttempts
      && (row.reasonCode === null || /^[A-Z][A-Z0-9_]{1,119}$/.test(row.reasonCode)), "KEYWORD_REFRESH_RECORD_INVALID");
    if (row.result !== null) need(JSON.stringify(smallResult(row.result)) === JSON.stringify(row.result), "KEYWORD_REFRESH_RECORD_INVALID");
    return row;
  }
  function smallResult(value) {
    need(plain(value) && ["published", "unchanged", "complete"].includes(value.status), "KEYWORD_REFRESH_RESULT_INVALID");
    const out = { status: value.status };
    for (const k of ["generation", "pointerSha256", "catalogSha256", "sourceFingerprint", "dataThrough"]) if (value[k] !== undefined) {
      need(typeof value[k] === "string" && value[k].length <= 160 && !/[\u0000-\u001f\u007f]/.test(value[k]), "KEYWORD_REFRESH_RESULT_INVALID");
      if (k.endsWith("Sha256") || k === "sourceFingerprint") need(SHA.test(value[k]), "KEYWORD_REFRESH_RESULT_INVALID");
      if (k === "generation") need(/^[a-f0-9]{32}$/.test(value[k]), "KEYWORD_REFRESH_RESULT_INVALID");
      if (k === "dataThrough") need(iso(value[k]), "KEYWORD_REFRESH_RESULT_INVALID"); out[k] = value[k];
    }
    for (const k of ["scopeCount", "refreshedScopeCount", "providerCalls"]) if (value[k] !== undefined) { need(Number.isSafeInteger(value[k]) && value[k] >= 0 && (k !== "providerCalls" || value[k] === 0), "KEYWORD_REFRESH_RESULT_INVALID"); out[k] = value[k]; }
    if (value.networkAttempted !== undefined) { need(value.networkAttempted === false, "KEYWORD_REFRESH_RESULT_INVALID"); out.networkAttempted = false; }
    need(Buffer.byteLength(JSON.stringify(out)) <= 4096, "KEYWORD_REFRESH_RESULT_BOUND"); return out;
  }
  async function ensureDirectories() {
    await checked(root, true);
    for (const dir of [directory, recordsDirectory]) { const parent = await checked(path.dirname(dir), true); try { await fileSystem.mkdir(dir, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; } const own = await checked(dir, true); if (process.platform !== "win32") need((own.mode & 0o777) === 0o700 && (typeof process.getuid !== "function" || own.uid === process.getuid()), "KEYWORD_REFRESH_PRIVATE_DIRECTORY_REQUIRED"); const after = await checked(path.dirname(dir), true); need(parent.dev === after.dev && parent.ino === after.ino, "KEYWORD_REFRESH_EVIDENCE_CHANGED"); }
  }
  async function syncDirectory(dir) {
    let h;
    try { h = await fileSystem.open(dir, native.constants.O_RDONLY); await h.sync(); await h.close(); h = null; }
    catch (e) { if (h) await h.close().catch(() => {}); if (process.platform !== "win32" || !["EISDIR", "EPERM", "EACCES", "EINVAL"].includes(e.code)) throw e; }
  }
  async function activation(create = false) {
    const file = path.join(directory, "activation.json");
    try {
      const { value } = await read(file);
      need(plain(value) && Object.keys(value).length === 3 && value.schemaVersion === 1 && iso(value.activatedAt)
        && text(value.initialRefreshVersion, 100) && /^[A-Za-z0-9_.-]+$/.test(value.initialRefreshVersion), "KEYWORD_REFRESH_ACTIVATION_INVALID");
      return value.activatedAt;
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (!create) return null;
    const at = stamp(), value = { schemaVersion: 1, activatedAt: at, initialRefreshVersion: refreshVersion };
    // Activation precedes the first accepted intent. Reconciliation may only
    // consider postprocess completions at/after this durable admission boundary.
    let h;
    try {
      h = await fileSystem.open(file, native.constants.O_WRONLY | native.constants.O_CREAT | native.constants.O_EXCL | (native.constants.O_NOFOLLOW || 0), 0o600);
      await h.writeFile(JSON.stringify(value)); await h.sync(); await h.close(); h = null; await syncDirectory(directory);
    } catch (e) { if (h) await h.close().catch(() => {}); if (e.code !== "EEXIST") throw e; }
    const actual = await activation(false); need(iso(actual), "KEYWORD_REFRESH_ACTIVATION_INVALID"); return actual;
  }
  async function scan() {
    const found = new Map(); let total = 0, count = 0;
    await checked(root, true);
    try { await checked(recordsDirectory, true); } catch (e) { if (e.code === "ENOENT") return { records: found, bytes: 0 }; throw e; }
    const before = await checked(recordsDirectory, true), entries = await fileSystem.readdir(recordsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      need(++count <= maxRecords * 2 + 16 && entry.isFile() && !entry.isSymbolicLink(), "KEYWORD_REFRESH_JOURNAL_BOUND");
      const file = path.join(recordsDirectory, entry.name), st = await checked(file); total += st.size; need(total <= maxJournalBytes, "KEYWORD_REFRESH_JOURNAL_BOUND");
      if (/^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(entry.name)) continue; // Crash debris never becomes a job or successful receipt.
      need(/^[a-f0-9]{64}\.json$/.test(entry.name) && found.size < maxRecords, "KEYWORD_REFRESH_RECORD_INVALID");
      const id = entry.name.slice(0, -5), r = await read(file); found.set(id, validate(r.value, id));
    }
    need(same(before, await checked(recordsDirectory, true)), "KEYWORD_REFRESH_EVIDENCE_CHANGED"); return { records: found, bytes: total };
  }
  async function writeRecord(row) {
    need(!storeError, storeError); validate(row, row.jobId);
    const b = Buffer.from(JSON.stringify(row)); need(b.length <= RECORD_BYTES, "KEYWORD_REFRESH_RECORD_BOUND");
    const file = fileFor(row.jobId), parent = await checked(recordsDirectory, true); let oldSize = 0;
    try { oldSize = (await checked(file)).size; } catch (e) { if (e.code !== "ENOENT") throw e; }
    need(journalBytes + b.length + RECORD_BYTES <= maxJournalBytes, "KEYWORD_REFRESH_JOURNAL_BOUND");
    const temporary = path.join(recordsDirectory, row.jobId + "." + crypto.randomUUID() + ".tmp"); let h;
    try {
      h = await fileSystem.open(temporary, native.constants.O_WRONLY | native.constants.O_CREAT | native.constants.O_EXCL | (native.constants.O_NOFOLLOW || 0), 0o600);
      await h.writeFile(b); await h.sync(); await h.close(); h = null;
      const currentParent = await checked(recordsDirectory, true); need(parent.dev === currentParent.dev && parent.ino === currentParent.ino, "KEYWORD_REFRESH_EVIDENCE_CHANGED");
      // Never replace an unsafe path, even with an atomic rename.
      try { await checked(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
      await fileSystem.rename(temporary, file);
      const actual = await read(file); need(actual.bytes === b.length && JSON.stringify(actual.value) === JSON.stringify(row), "KEYWORD_REFRESH_PUBLICATION_NEEDS_READBACK");
      await syncDirectory(recordsDirectory);
      records.set(row.jobId, row); journalBytes += b.length - oldSize; return publicRow(row);
    } catch (e) { storeError = safeCode(e); throw e; }
    finally { if (h) await h.close().catch(() => {}); await fileSystem.unlink(temporary).catch(() => {}); }
  }
  async function initialize() {
    if (!initializing) initializing = (async () => {
      await ensureDirectories(); activatedAt = await activation(true); const found = await scan(); records.clear(); for (const [id, row] of found.records) records.set(id, row); journalBytes = found.bytes;
      for (const row of [...records.values()]) if (row.status === "running") {
        const at = stamp(), exhausted = row.attempts >= row.maxAttempts;
        await writeRecord({ ...row, status: exhausted ? "needs_verification" : "queued", reasonCode: exhausted ? "KEYWORD_REFRESH_INTERRUPTED_EXHAUSTED" : "KEYWORD_REFRESH_INTERRUPTED", updatedAt: at, recoveredAt: at, finishedAt: exhausted ? at : null, nextAttemptAt: exhausted ? null : at });
      }
      initialized = true;
    })().catch(e => { storeError = safeCode(e); throw e; });
    return initializing;
  }
  async function enqueue(input) {
    try {
      const intent = intentFor(input), jobId = idFor(intent);
      const result = await locked(async () => {
        need(!closed, "KEYWORD_REFRESH_CLOSED");
        // An independent late completion reconciler can retry a failed enqueue
        // after storage recovers. Re-read/validate every journal record first;
        // never clear an unsafe record, a foreign lock, or an original receipt.
        if (storeError) { initialized = false; initializing = null; storeError = null; }
        await initialize(); need(!storeError, storeError); lastEnqueueError = null;
        if (records.has(jobId)) return publicRow(records.get(jobId));
        need(records.size < maxRecords && [...records.values()].filter(r => !["complete", "needs_verification"].includes(r.status)).length < maxPending, "KEYWORD_REFRESH_QUEUE_FULL");
        const at = stamp(); return writeRecord({ schemaVersion: 1, jobId, intent, status: "queued", reasonCode: null, createdAt: at, updatedAt: at, startedAt: null, finishedAt: null, nextAttemptAt: at, recoveredAt: null, attempts: 0, maxAttempts, result: null });
      });
      if (started) schedule(0); return result;
    } catch (e) { lastEnqueueError = safeCode(e); return { status: "needs_verification", state: "needs_verification", errorCode: lastEnqueueError, collectionPostprocessUnaffected: true }; }
  }
  function evidenceFor(value, intent) {
    if (value == null || value.ready === false || value.pending === true || ["pending", "held", "queued", "running", "waiting", "collecting", "postprocessing"].includes(value.postprocessStatus)
      || ["pending", "held", "queued", "running", "waiting", "collecting", "postprocessing"].includes(value.status)) return { ready: false };
    need(plain(value) && value.runId === intent.runId && value.keyword === intent.keyword && value.manifestSha256 === intent.manifestSha256
      && (value.scheduleOccurrenceId ?? null) === intent.scheduleOccurrenceId, "KEYWORD_REFRESH_EVIDENCE_MISMATCH");
    need(value.status === "complete" && value.quality === "complete" && value.postprocessStatus === "complete", "KEYWORD_REFRESH_COMPLETION_NOT_VERIFIED");
    return { ready: true, value };
  }
  async function defer(row, code, delay = idleIntervalMs) {
    const at = stamp(), until = new Date(Date.parse(at) + delay).toISOString(); deferredUntil.set(row.jobId, until);
    if (row.status === "deferred" && row.reasonCode === code) return publicRow(row);
    return locked(() => writeRecord({ ...row, status: "deferred", reasonCode: code, updatedAt: at, nextAttemptAt: until }));
  }
  async function once() {
    try {
      await initialize(); need(!storeError, storeError); if (closed) return null;
      const dueAt = row => deferredUntil.get(row.jobId) || row.nextAttemptAt;
      const at = stamp(), row = [...records.values()].filter(r => ["queued", "deferred"].includes(r.status) && dueAt(r) <= at)
        .sort((a, b) => dueAt(a).localeCompare(dueAt(b)) || a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId))[0]; if (!row) return null;
      let admission;
      try { admission = await canProcess(publicRow(row)); } catch { return defer(row, "KEYWORD_REFRESH_ADMISSION_UNAVAILABLE"); }
      const allowed = admission === true || plain(admission) && admission.allowed === true;
      if (!allowed) return defer(row, plain(admission) && /^[A-Z][A-Z0-9_]{1,119}$/.test(admission.reasonCode || "") ? admission.reasonCode : "KEYWORD_REFRESH_BACKGROUND_DEFERRED");
      let proof;
      try { proof = evidenceFor(await readCompletedEvidence(clone(row.intent)), row.intent); }
      catch (e) { const t = stamp(); return locked(() => writeRecord({ ...row, status: "needs_verification", reasonCode: safeCode(e), updatedAt: t, finishedAt: t, nextAttemptAt: null })); }
      if (!proof.ready) return defer(row, "KEYWORD_REFRESH_POSTPROCESS_NOT_COMPLETE");
      if (closed) return null;
      deferredUntil.delete(row.jobId);
      const began = stamp(), running = { ...row, status: "running", reasonCode: null, updatedAt: began, startedAt: began, nextAttemptAt: null, attempts: row.attempts + 1 };
      await locked(() => writeRecord(running)); activeJobId = row.jobId; controller = new AbortController();
      try {
        const result = smallResult(await refresh(proof.value, clone(row.intent), { jobId: row.jobId, attempt: running.attempts, recoveredAt: row.recoveredAt, signal: controller.signal }));
        const end = stamp(); return await locked(() => writeRecord({ ...running, status: "complete", reasonCode: null, updatedAt: end, finishedAt: end, nextAttemptAt: null, result }));
      } catch (e) {
        if (storeError) throw e;
        const end = stamp(), uncertain = e?.publicationState === "pointer_was_promoted_verify_current" || /(?:PUBLICATION_NEEDS_READBACK|POINTER_CONFLICT|PUBLICATION_LOCKED)$/.test(e?.code || "");
        if (!uncertain && e?.deferred === true && !Object.hasOwn(e, "publicationState")) {
          // The runner rechecks admission after waiting for its background
          // memory lease. A verified pre-publication deferral is not a failed
          // preparation attempt and must not exhaust the retry allowance.
          return await locked(() => writeRecord({ ...running, status: "deferred", reasonCode: safeCode(e), attempts: row.attempts,
            startedAt: row.startedAt, updatedAt: end, finishedAt: null, nextAttemptAt: new Date(Date.parse(end) + idleIntervalMs).toISOString() }));
        }
        const retry = !uncertain && e?.retryable === true && running.attempts < running.maxAttempts;
        const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** (running.attempts - 1));
        return await locked(() => writeRecord({ ...running, status: retry ? "deferred" : "needs_verification", reasonCode: safeCode(e), updatedAt: end, finishedAt: retry ? null : end, nextAttemptAt: retry ? new Date(Date.parse(end) + delay).toISOString() : null }));
      } finally { activeJobId = null; controller = null; }
    } catch (e) { lastWorkerError = safeCode(e); return { status: "needs_verification", errorCode: lastWorkerError, collectionPostprocessUnaffected: true }; }
  }
  function runOnce() { if (!workerPromise) workerPromise = once().finally(() => { workerPromise = null; }); return workerPromise; }
  function schedule(delay = idleIntervalMs) {
    if (!started || closed || timer || storeError) return;
    timer = setTimeoutImpl(() => { timer = null; runOnce().finally(() => schedule()); }, delay); timer?.unref?.();
  }
  async function start() { if (closed) return { status: "needs_verification", errorCode: "KEYWORD_REFRESH_CLOSED" }; try { await locked(initialize); started = true; schedule(0); return status(); } catch (e) { lastWorkerError = safeCode(e); return { status: "needs_verification", errorCode: lastWorkerError }; } }
  async function close() { closed = true; started = false; if (timer) clearTimeoutImpl(timer); timer = null; controller?.abort(); if (workerPromise) await workerPromise; await serial; }
  async function status({ limit = 100 } = {}) {
    need(Number.isSafeInteger(limit) && limit >= 0 && limit <= 512, "KEYWORD_REFRESH_STATUS_LIMIT");
    try {
      // A GET can inspect even a cold journal but cannot mkdir, recover, enqueue,
      // start a worker or promote a bundle. Disk-only status is explicitly marked.
      const view = initialized ? { records, bytes: journalBytes } : await scan(), rows = [...view.records.values()], admissionAt = initialized ? activatedAt : await activation(false);
      const unresolved = rows.filter(row => row.status === "needs_verification");
      return { schemaVersion: 1, status: storeError || lastWorkerError || lastEnqueueError || unresolved.length ? "needs_verification" : "available", readOnly: true,
        initialized, started, closed, activeJobId, refreshVersion, activatedAt: admissionAt, errorCode: storeError || lastWorkerError || lastEnqueueError,
        unresolvedNeedsVerification: unresolved.length,
        journalBytes: view.bytes, maxJournalBytes, maxRecords, counts: rows.reduce((n, r) => { n[r.status] = (n[r.status] || 0) + 1; return n; }, {}),
        items: rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.jobId.localeCompare(a.jobId)).slice(0, limit).map(publicRow) };
    } catch (e) { return { schemaVersion: 1, status: "needs_verification", readOnly: true, errorCode: safeCode(e), items: null, counts: null }; }
  }
  return Object.freeze({ enqueue, runOnce, start, close, status, directory, refreshVersion });
}

module.exports = { createKeywordMonthlyRefresh, KEYWORD_MONTHLY_REFRESH_VERSION: VERSION };
