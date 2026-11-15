"use strict";

// A single-writer, immutable outbox for inputs already held by the source writer.
// It never opens a master/history/output/provider file. Outbox completion proves
// only transport durability; the consumer must separately verify the exact run's
// durable DB receipt and source stamps before adopting an event.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const VERSION = 1, SHA = /^[a-f0-9]{64}$/, RUN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/;
const LIMITS = Object.freeze({ eventBytes: 32 * 1024 * 1024, outboxBytes: 512 * 1024 * 1024, entries: 16384,
  rows: 100000, changes: 50000, order: 100000, stampBytes: 16384, nodes: 1000000, depth: 64 });
const MARKER_BYTES = 8192, KINDS = new Set(["companies", "history"]);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fault = code => Object.assign(new Error(code), { code: "KEYWORD_DELTA_" + code });
const need = (value, code) => { if (!value) throw fault(code); };
const text = value => typeof value === "string" && value.length > 0 && value.length <= 300 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const same = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].every(key => a[key] === b[key]);
const iso = value => typeof value === "string" && /^20\d\d-\d\d-\d\dT.*Z$/.test(value) && Number.isFinite(Date.parse(value));
const safeCode = error => /^(?:KEYWORD_DELTA_[A-Z0-9_]{1,100}|E[A-Z0-9]{1,30})$/.test(error?.code || "") ? error.code : "KEYWORD_DELTA_UNAVAILABLE";

function createKeywordMonthlySourceDelta({ dataDir, now = () => new Date(), fileSystem = fs, limits: supplied = {} } = {}) {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir) || typeof now !== "function" || !plain(supplied)
    || Object.keys(supplied).some(key => !Object.hasOwn(LIMITS, key))) throw new TypeError("Delta outbox requires an absolute dataDir and valid bounds");
  const limits = { ...LIMITS, ...supplied };
  if (Object.keys(limits).some(key => !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > LIMITS[key])) throw new TypeError("Invalid delta outbox bound");
  const root = path.resolve(dataDir), directory = path.join(root, "keyword_monthly_source_delta");
  const pendingDir = path.join(directory, "pending"), completeDir = path.join(directory, "complete");
  let serial = Promise.resolve();
  const locked = operation => { const result = serial.then(operation); serial = result.catch(() => {}); return result; };
  const clock = () => { const value = new Date(now()); need(Number.isFinite(value.getTime()), "CLOCK_INVALID"); return value.toISOString(); };
  const failed = (error, eventId = null, attempted = false) => ({ status: "needs_verification", errorCode: safeCode(error), eventId,
    publicationState: attempted ? "unknown" : "not_started", sourceWrites: 0, collectionPostprocessUnaffected: true });

  // Reject values JSON would silently discard, invoke or coerce. Company/row key
  // order remains untouched: neither canonical sorting nor identity coercion is
  // permitted. Snapshot inputs synchronously before waiting for the writer turn.
  function jsonBytes(value) {
    let nodes = 0; const parents = new Set();
    function visit(item, depth) {
      need(++nodes <= limits.nodes && depth <= limits.depth, "INPUT_BOUND");
      if (item === null || typeof item === "string" || typeof item === "boolean") return;
      if (typeof item === "number") { need(Number.isFinite(item), "INPUT_NOT_JSON"); return; }
      need(typeof item === "object" && (Array.isArray(item) || plain(item)) && !parents.has(item), "INPUT_NOT_JSON");
      need(Object.getOwnPropertySymbols(item).length === 0, "INPUT_NOT_JSON"); parents.add(item);
      if (Array.isArray(item)) need(Object.keys(item).length === item.length && Object.keys(item).every((key, index) => key === String(index)), "INPUT_NOT_JSON");
      for (const key of Object.keys(item)) { const descriptor = Object.getOwnPropertyDescriptor(item, key); need(Object.hasOwn(descriptor, "value"), "INPUT_NOT_JSON"); visit(descriptor.value, depth + 1); }
      parents.delete(item);
    }
    visit(value, 0); const bytes = Buffer.from(JSON.stringify(value)); need(bytes.length <= limits.eventBytes, "EVENT_BOUND"); return bytes;
  }
  function payloadFor(kind, input) {
    // Inspect descriptors before accessing fields, including sourceStamp getters.
    jsonBytes(input);
    const keys = kind === "companies" ? ["changes", "order", "sourceStamp"] : ["rows", "sourceStamp", "indexUpdated", "runId"];
    need(plain(input) && Object.keys(input).every(key => keys.includes(key)) && plain(input.sourceStamp) && Object.keys(input.sourceStamp).length > 0, "INPUT_INVALID");
    need(jsonBytes(input.sourceStamp).length <= limits.stampBytes, "STAMP_BOUND");
    if (kind === "history") {
      need(Array.isArray(input.rows) && input.rows.length <= limits.rows && input.rows.every(plain)
        && typeof input.indexUpdated === "boolean" && (input.runId == null || RUN.test(input.runId)), "INPUT_INVALID");
      return { runId: input.runId ?? null, rows: input.rows, sourceStamp: input.sourceStamp, indexUpdated: input.indexUpdated };
    }
    need(Array.isArray(input.changes) && input.changes.length <= limits.changes && Array.isArray(input.order) && input.order.length <= limits.order
      && input.order.every(text) && new Set(input.order).size === input.order.length, "INPUT_INVALID");
    const seen = new Set();
    for (const change of input.changes) {
      need(exact(change, ["companyId", "company", "orderIndex"]) && text(change.companyId) && !seen.has(change.companyId), "INPUT_INVALID"); seen.add(change.companyId);
      need(change.company === null || plain(change.company) && change.company.companyId === change.companyId, "INPUT_INVALID");
      if (change.company === null) need((change.orderIndex === null || Number.isSafeInteger(change.orderIndex) && change.orderIndex >= 0) && !input.order.includes(change.companyId), "INPUT_INVALID");
      else need(Number.isSafeInteger(change.orderIndex) && change.orderIndex >= 0 && input.order[change.orderIndex] === change.companyId, "INPUT_INVALID");
    }
    return { changes: input.changes, order: input.order, sourceStamp: input.sourceStamp };
  }
  const identityBytes = (kind, payload) => Buffer.from(JSON.stringify({ schemaVersion: VERSION, kind, payload }));
  function validateEvent(value, id) {
    need(exact(value, ["schemaVersion", "eventId", "kind", "createdAt", "payload"]) && value.schemaVersion === VERSION && value.eventId === id
      && SHA.test(id) && KINDS.has(value.kind) && iso(value.createdAt), "EVENT_INVALID");
    const payload = payloadFor(value.kind, value.payload);
    need(JSON.stringify(payload) === JSON.stringify(value.payload) && hash(identityBytes(value.kind, payload)) === id, "EVENT_HASH_MISMATCH"); return value;
  }
  function validateMarker(value, id) {
    need(exact(value, ["schemaVersion", "status", "eventId", "kind", "eventSha256", "eventBytes", "createdAt", "completedAt"])
      && value.schemaVersion === VERSION && value.status === "complete" && value.eventId === id && SHA.test(id) && KINDS.has(value.kind)
      && SHA.test(value.eventSha256) && Number.isSafeInteger(value.eventBytes) && value.eventBytes > 0 && value.eventBytes <= limits.eventBytes
      && iso(value.createdAt) && iso(value.completedAt), "MARKER_INVALID"); return value;
  }
  async function checked(file, isDirectory = false) {
    need(path.isAbsolute(file) && samePath(path.resolve(file), file), "PATH_UNSAFE"); let current = path.parse(file).root;
    for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part); const stat = await fileSystem.lstat(current);
      need(!stat.isSymbolicLink() && (current === file || stat.isDirectory()) && samePath(await fileSystem.realpath(current), current), "PATH_UNSAFE");
    }
    const stat = await fileSystem.lstat(file); need(isDirectory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, "PATH_UNSAFE");
    if (process.platform !== "win32" && (file === directory || file.startsWith(directory + path.sep))) {
      need(stat.uid === process.getuid() && (isDirectory ? (stat.mode & 0o777) === 0o700 : (stat.mode & 0o022) === 0), "PATH_OWNER");
    }
    return stat;
  }
  async function read(file, maximum) {
    const before = await checked(file); need(before.size > 0 && before.size <= maximum, "READ_BOUND");
    const handle = await fileSystem.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0)); let bytes;
    try {
      need(same(before, await handle.stat()), "EVIDENCE_CHANGED"); const buffer = Buffer.alloc(before.size + 1); let count = 0;
      while (count < buffer.length) { const row = await handle.read(buffer, count, buffer.length - count, count); if (!row.bytesRead) break; count += row.bytesRead; }
      need(count === before.size && same(before, await handle.stat()), "EVIDENCE_CHANGED"); bytes = buffer.subarray(0, count);
    } finally { await handle.close(); }
    need(same(before, await checked(file)), "EVIDENCE_CHANGED"); let value;
    try { value = JSON.parse(bytes); } catch { throw fault("JSON_INVALID"); }
    return { value, bytes, sha256: hash(bytes), stat: before };
  }
  async function maybeRead(file, maximum) { try { return await read(file, maximum); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
  async function syncDirectory(file) {
    let handle;
    try { handle = await fileSystem.open(file, native.constants.O_RDONLY); await handle.sync(); }
    catch (error) { if (process.platform !== "win32" || !["EISDIR", "EPERM", "EACCES", "EINVAL"].includes(error.code)) throw error; }
    finally { if (handle) await handle.close(); }
  }
  async function ensureDirectories() {
    await checked(root, true);
    for (const dir of [directory, pendingDir, completeDir]) {
      const before = await checked(path.dirname(dir), true);
      try { await fileSystem.mkdir(dir, { mode: 0o700 }); await syncDirectory(path.dirname(dir)); } catch (error) { if (error.code !== "EEXIST") throw error; }
      const own = await checked(dir, true);
      if (process.platform !== "win32") need(own.uid === process.getuid() && (own.mode & 0o777) === 0o700, "PRIVATE_DIRECTORY_REQUIRED");
      need(identity(before, await checked(path.dirname(dir), true)), "EVIDENCE_CHANGED");
    }
  }
  async function inventory() {
    await checked(root, true); let parent;
    try { parent = await checked(directory, true); } catch (error) { if (error.code === "ENOENT") return { missing: true, files: [], bytes: 0, digest: hash("[]") }; throw error; }
    const children = await fileSystem.readdir(directory, { withFileTypes: true });
    need(children.length === 2 && children.every(entry => entry.isDirectory() && !entry.isSymbolicLink() && ["pending", "complete"].includes(entry.name)), "INVENTORY_INVALID");
    const files = []; let bytes = 0;
    for (const dir of [pendingDir, completeDir]) {
      const before = await checked(dir, true), entries = await fileSystem.opendir(dir);
      for await (const entry of entries) {
        need(files.length < limits.entries && entry.isFile() && !entry.isSymbolicLink() && /^[a-f0-9]{64}\.(?:json|tmp)$/.test(entry.name), "INVENTORY_INVALID");
        const stat = await checked(path.join(dir, entry.name)); bytes += stat.size;
        need(bytes <= limits.outboxBytes && stat.size > 0 && stat.size <= (dir === pendingDir ? limits.eventBytes : MARKER_BYTES), "OUTBOX_BOUND");
        files.push({ kind: dir === pendingDir ? "pending" : "complete", name: entry.name, bytes: stat.size, signature: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":") });
      }
      need(same(before, await checked(dir, true)), "EVIDENCE_CHANGED");
    }
    need(identity(parent, await checked(directory, true)), "EVIDENCE_CHANGED");
    files.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    return { missing: false, files, bytes, digest: hash(JSON.stringify(files)) };
  }
  // A deterministic temporary file can be adopted after restart only when its
  // complete bytes match. Damaged/foreign work is kept for review, never deleted.
  async function publishNew(file, bytes, maximum) {
    const old = await maybeRead(file, maximum);
    if (old) { need(old.bytes.equals(bytes), "IMMUTABLE_CONFLICT"); return; }
    const parent = await checked(path.dirname(file), true), temporary = file.slice(0, -5) + ".tmp";
    const prior = await maybeRead(temporary, maximum);
    if (prior) need(prior.bytes.equals(bytes), "IMMUTABLE_CONFLICT");
    else {
      const handle = await fileSystem.open(temporary, native.constants.O_WRONLY | native.constants.O_CREAT | native.constants.O_EXCL | (native.constants.O_NOFOLLOW || 0), 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    }
    need(identity(parent, await checked(path.dirname(file), true)), "EVIDENCE_CHANGED");
    const raced = await maybeRead(file, maximum); need(!raced, "IMMUTABLE_CONFLICT");
    await fileSystem.rename(temporary, file); await syncDirectory(path.dirname(file));
    const actual = await read(file, maximum); need(actual.bytes.equals(bytes), "PUBLICATION_NEEDS_READBACK");
  }
  async function eventOwned(id) {
    need(SHA.test(id), "EVENT_ID_INVALID");
    const markerFile = path.join(completeDir, id + ".json"), marker = await read(markerFile, MARKER_BYTES); validateMarker(marker.value, id);
    const saved = await read(path.join(pendingDir, id + ".json"), limits.eventBytes); validateEvent(saved.value, id);
    need(saved.sha256 === marker.value.eventSha256 && saved.bytes.length === marker.value.eventBytes && saved.value.kind === marker.value.kind
      && saved.value.createdAt === marker.value.createdAt, "COMPLETION_MISMATCH");
    const after = await read(markerFile, MARKER_BYTES); need(marker.sha256 === after.sha256 && same(marker.stat, after.stat), "EVIDENCE_CHANGED");
    return { status: "complete", eventId: id, eventSha256: saved.sha256, eventBytes: saved.bytes.length, event: saved.value, sourceWrites: 0 };
  }
  function record(kind, input) {
    let payload, id;
    try { payload = JSON.parse(jsonBytes(payloadFor(kind, input))); id = hash(identityBytes(kind, payload)); }
    catch (error) { return Promise.resolve(failed(error)); }
    return locked(async () => {
      let attempted = false;
      try {
        await ensureDirectories(); const before = await inventory();
        const pendingFile = path.join(pendingDir, id + ".json"), completeFile = path.join(completeDir, id + ".json");
        const completed = await maybeRead(completeFile, MARKER_BYTES);
        if (completed) { const { event: ignored, ...result } = await eventOwned(id); return { ...result, alreadyRecorded: true }; }
        let saved = await maybeRead(pendingFile, limits.eventBytes) || await maybeRead(pendingFile.slice(0, -5) + ".tmp", limits.eventBytes);
        if (saved) { validateEvent(saved.value, id); need(saved.value.kind === kind && JSON.stringify(saved.value.payload) === JSON.stringify(payload), "IMMUTABLE_CONFLICT"); }
        const event = saved?.value || { schemaVersion: VERSION, eventId: id, kind, createdAt: clock(), payload };
        const bytes = Buffer.from(JSON.stringify(event)); need(bytes.length <= limits.eventBytes, "EVENT_BOUND");
        const savedMarker = await maybeRead(completeFile.slice(0, -5) + ".tmp", MARKER_BYTES);
        if (savedMarker) validateMarker(savedMarker.value, id);
        const marker = savedMarker?.value || { schemaVersion: VERSION, status: "complete", eventId: id, kind,
          eventSha256: hash(bytes), eventBytes: bytes.length, createdAt: event.createdAt, completedAt: clock() };
        need(marker.kind === kind && marker.eventSha256 === hash(bytes) && marker.eventBytes === bytes.length && marker.createdAt === event.createdAt, "COMPLETION_MISMATCH");
        const markerBytes = Buffer.from(JSON.stringify(marker)), addedEntries = Number(!saved) + Number(!savedMarker);
        need(before.files.length + addedEntries <= limits.entries && before.bytes + (saved ? 0 : bytes.length) + (savedMarker ? 0 : markerBytes.length) <= limits.outboxBytes, "OUTBOX_BOUND");
        attempted = true; await publishNew(pendingFile, bytes, limits.eventBytes); await publishNew(completeFile, markerBytes, MARKER_BYTES);
        const { event: ignored, ...result } = await eventOwned(id); return { ...result, alreadyRecorded: false };
      } catch (error) { return failed(error, id, attempted); }
    });
  }
  async function readEvent(id) { return locked(async () => { try { return await eventOwned(id); } catch (error) { return failed(error, SHA.test(id) ? id : null); } }); }
  async function listEvents({ limit = 128, offset = 0, expectedInventorySha256 = null } = {}) {
    return locked(async () => {
      try {
        need(Number.isSafeInteger(limit) && limit >= 1 && limit <= limits.entries && Number.isSafeInteger(offset) && offset >= 0
          && (expectedInventorySha256 === null || SHA.test(expectedInventorySha256)), "LIST_OPTIONS_INVALID");
        const snapshot = await inventory(); need(expectedInventorySha256 === null || expectedInventorySha256 === snapshot.digest, "INVENTORY_CHANGED");
        const pending = new Set(snapshot.files.filter(row => row.kind === "pending" && row.name.endsWith(".json")).map(row => row.name.slice(0, -5)));
        const complete = snapshot.files.filter(row => row.kind === "complete" && row.name.endsWith(".json")).map(row => row.name.slice(0, -5));
        need(complete.every(id => pending.has(id)), "COMPLETION_MISMATCH");
        const completeSet = new Set(complete), incomplete = new Set([...pending].filter(id => !completeSet.has(id)));
        for (const row of snapshot.files) if (row.name.endsWith(".tmp")) incomplete.add(row.name.slice(0, -4));
        const events = [];
        for (const id of complete.slice(offset, offset + limit)) {
          const saved = await read(path.join(completeDir, id + ".json"), MARKER_BYTES), marker = validateMarker(saved.value, id);
          const payload = snapshot.files.find(row => row.kind === "pending" && row.name === id + ".json"); need(payload.bytes === marker.eventBytes, "COMPLETION_MISMATCH");
          events.push({ ...marker, payloadValidated: false });
        }
        need((await inventory()).digest === snapshot.digest, "INVENTORY_CHANGED");
        return { status: incomplete.size ? "needs_verification" : "available", errorCode: incomplete.size ? "KEYWORD_DELTA_INCOMPLETE_EVENTS" : null,
          events, incompleteEventIds: [...incomplete].sort(), completeCount: complete.length, inventorySha256: snapshot.digest,
          nextOffset: offset + events.length < complete.length ? offset + events.length : null, readOnly: true, sourceWrites: 0 };
      } catch (error) { return { ...failed(error), events: null, incompleteEventIds: null, completeCount: null, inventorySha256: null, nextOffset: null, readOnly: true }; }
    });
  }
  return Object.freeze({ recordCompanyDelta: input => record("companies", input), recordHistoryDelta: input => record("history", input), readEvent, listEvents, directory });
}
module.exports = { createKeywordMonthlySourceDelta, KEYWORD_MONTHLY_SOURCE_DELTA_LIMITS: LIMITS };
