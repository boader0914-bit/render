"use strict";
// Host-side, explicitly exclusive derived-checkpoint identity re-anchoring.
// Never imported by the analytical child; no collector, application, source
// writer, financial calculation or network capability is imported here.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const H = require("./keyword_monthly_refresh_preparation.cjs");
const S = require("./keyword_monthly_incremental_state.cjs");
const { createKeywordMonthlySourceDelta } = require("./keyword_monthly_source_delta.cjs");
const VERSION = "keyword-monthly-source-relocation-v1", POLICY = "dev_only_full_bootstrap_bytes_reverified_each_time";
const LIMITS = Object.freeze({ sourceBytes: 2 * 1024 ** 3, milliseconds: 15 * 60000, bufferBytes: 1024 * 1024,
  pointerBytes: 16384, receiptBytes: 1024 * 1024, events: 50000, eventBytes: 32 * 1024 * 1024, totalEventBytes: 512 * 1024 * 1024 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), bytesFor = value => Buffer.from(JSON.stringify(value));
const fault = code => Object.assign(new Error(code), { code });
const need = (value, code) => { if (!value) throw fault(code); };
const fields = ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"];
const exactStamp = stamp => stamp && S.validStamp(stamp) && Object.keys(stamp).length === fields.length && fields.every(key => Object.hasOwn(stamp, key));
const sameStamp = (a, b) => exactStamp(a) && exactStamp(b) && fields.every(key => a[key] === b[key]);
const devOnly = (a, b) => exactStamp(a) && exactStamp(b) && fields.filter(key => key !== "dev").every(key => a[key] === b[key]);
const sameFile = (a, b) => [...fields, "mode", "uid", "gid"].every(key => String(a[key]) === String(b[key]));
const sameParent = (a, b) => ["dev", "ino", "mode", "uid", "gid"].every(key => String(a[key]) === String(b[key]));
async function checked(file, directory = false) { await H.checked(file, directory); const value = await fs.lstat(file, { bigint: true });
  need(directory ? value.isDirectory() : value.isFile() && value.nlink === 1n, "KEYWORD_SOURCE_RELOCATION_PATH_UNSAFE"); return value; }
async function readRaw(file, maximum) {
  const before = await checked(file); need(before.size > 0n && before.size <= BigInt(maximum), "KEYWORD_SOURCE_RELOCATION_READ_BOUND");
  const handle = await fs.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0)); let bytes;
  try { need(sameFile(before, await handle.stat({ bigint: true })), "KEYWORD_SOURCE_RELOCATION_EVIDENCE_CHANGED");
    const buffer = Buffer.alloc(Number(before.size) + 1); let offset = 0;
    while (offset < buffer.length) { const row = await handle.read(buffer, offset, buffer.length - offset, offset); if (!row.bytesRead) break; offset += row.bytesRead; }
    need(offset === Number(before.size) && sameFile(before, await handle.stat({ bigint: true })), "KEYWORD_SOURCE_RELOCATION_EVIDENCE_CHANGED"); bytes = buffer.subarray(0, offset);
  } finally { await handle.close(); }
  need(sameFile(before, await checked(file)), "KEYWORD_SOURCE_RELOCATION_EVIDENCE_CHANGED"); return { bytes, sha256: hash(bytes), stat: before };
}
async function syncDirectory(directory) { if (process.platform !== "win32") { const handle = await fs.open(directory, native.constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } } }
async function privateDirectory(directory, exclusive = false) {
  await checked(path.dirname(directory), true);
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; need(!exclusive, "KEYWORD_SOURCE_RELOCATION_AUDIT_EXISTS"); }
  const stat = await checked(directory, true);
  need(process.platform === "win32" || stat.uid === BigInt(process.getuid()) && (stat.mode & 0o777n) === 0o700n, "KEYWORD_SOURCE_RELOCATION_AUDIT_UNSAFE");
  await syncDirectory(path.dirname(directory)); return stat;
}
async function writeNew(file, bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= LIMITS.receiptBytes, "KEYWORD_SOURCE_RELOCATION_RECEIPT_BOUND");
  const parent = await checked(path.dirname(file), true), handle = await fs.open(file, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  need(sameParent(parent, await checked(path.dirname(file), true)), "KEYWORD_SOURCE_RELOCATION_AUDIT_CHANGED");
  const read = await readRaw(file, LIMITS.receiptBytes); need(read.sha256 === hash(bytes), "KEYWORD_SOURCE_RELOCATION_AUDIT_READBACK"); await syncDirectory(path.dirname(file));
  return { file, sha256: read.sha256, bytes: read.bytes.length };
}
async function outboxEvidence(outbox, appliedEvents, checkpoint) {
  need(Array.isArray(appliedEvents) && appliedEvents.length <= LIMITS.events && appliedEvents.every(id => H.SHA.test(id))
    && new Set(appliedEvents).size === appliedEvents.length, "KEYWORD_SOURCE_RELOCATION_APPLIED_EVENTS_INVALID");
  const descriptors = []; let offset = 0, inventory = null;
  do {
    await checkpoint(); const listed = await outbox.listEvents({ limit: 128, offset, ...(inventory ? { expectedInventorySha256: inventory } : {}) });
    need(listed.status === "available" && H.SHA.test(listed.inventorySha256 || "") && Array.isArray(listed.events)
      && Array.isArray(listed.incompleteEventIds) && listed.incompleteEventIds.length === 0
      && listed.completeCount === appliedEvents.length, "KEYWORD_SOURCE_RELOCATION_OUTBOX_UNVERIFIED");
    inventory ||= listed.inventorySha256; need(inventory === listed.inventorySha256, "KEYWORD_SOURCE_RELOCATION_OUTBOX_CHANGED");
    need(listed.events.length <= 128 && descriptors.length + listed.events.length <= LIMITS.events, "KEYWORD_SOURCE_RELOCATION_OUTBOX_BOUND");
    descriptors.push(...listed.events);
    need(listed.nextOffset === null || Number.isSafeInteger(listed.nextOffset) && listed.nextOffset === offset + listed.events.length && listed.nextOffset > offset,
      "KEYWORD_SOURCE_RELOCATION_OUTBOX_UNVERIFIED"); offset = listed.nextOffset;
  } while (offset !== null);
  const ids = descriptors.map(row => row.eventId), expected = [...appliedEvents].sort();
  need(ids.every(id => H.SHA.test(id)) && new Set(ids).size === ids.length && JSON.stringify([...ids].sort()) === JSON.stringify(expected), "KEYWORD_SOURCE_RELOCATION_DELTA_SET_CHANGED");
  const rows = []; let totalBytes = 0;
  for (const descriptor of descriptors) {
    await checkpoint(); const read = await outbox.readEvent(descriptor.eventId), event = read.event;
    need(descriptor.status === "complete" && read.status === "complete" && read.eventId === descriptor.eventId && event?.eventId === descriptor.eventId && event.schemaVersion === 1
      && ["companies", "history"].includes(event.kind) && event.kind === descriptor.kind && event.createdAt === descriptor.createdAt
      && H.SHA.test(descriptor.eventSha256 || "") && read.eventSha256 === descriptor.eventSha256,
      "KEYWORD_SOURCE_RELOCATION_EVENT_UNVERIFIED");
    const bytes = bytesFor(event), identity = hash(bytesFor({ schemaVersion: event.schemaVersion, kind: event.kind, payload: event.payload }));
    totalBytes += bytes.length;
    need(bytes.length > 0 && bytes.length <= LIMITS.eventBytes && totalBytes <= LIMITS.totalEventBytes && read.eventBytes === bytes.length
      && descriptor.eventBytes === bytes.length && hash(bytes) === descriptor.eventSha256 && identity === descriptor.eventId,
      "KEYWORD_SOURCE_RELOCATION_EVENT_IDENTITY_CHANGED");
    rows.push([descriptor.eventId, descriptor.eventSha256, bytes.length]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0])); return { inventorySha256: inventory, eventCount: rows.length, totalEventBytes: totalBytes, eventsSha256: hash(bytesFor(rows)) };
}
async function streamSource(file, expected, bootstrap, checkpoint) {
  const before = await checked(file), parent = await checked(path.dirname(file), true);
  need(sameStamp(S.sourceStamp(before), expected) && BigInt(expected.size) <= BigInt(LIMITS.sourceBytes), "KEYWORD_SOURCE_RELOCATION_SOURCE_CHANGED");
  const handle = await fs.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0)), digest = crypto.createHash("sha256"); let offset = 0;
  try {
    need(sameFile(before, await handle.stat({ bigint: true })), "KEYWORD_SOURCE_RELOCATION_SOURCE_CHANGED"); const buffer = Buffer.alloc(LIMITS.bufferBytes);
    while (true) {
      await checkpoint(false); const row = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset + 1), offset);
      if (!row.bytesRead) break; offset += row.bytesRead;
      need(offset <= Number(before.size) && offset <= LIMITS.sourceBytes, "KEYWORD_SOURCE_RELOCATION_SOURCE_CHANGED"); digest.update(buffer.subarray(0, row.bytesRead));
    }
    need(offset === Number(before.size) && sameFile(before, await handle.stat({ bigint: true })), "KEYWORD_SOURCE_RELOCATION_SOURCE_CHANGED");
  } finally { await handle.close(); }
  need(sameFile(before, await checked(file)) && sameParent(parent, await checked(path.dirname(file), true)), "KEYWORD_SOURCE_RELOCATION_SOURCE_CHANGED");
  const sha256 = digest.digest("hex"); need(offset === bootstrap.bytes && sha256 === bootstrap.sha256, "KEYWORD_SOURCE_RELOCATION_BOOTSTRAP_HASH_MISMATCH");
  await checkpoint(); return { sha256, bytes: offset, sourceStamp: expected };
}
async function assertPriorAudit(directory, state) {
  const tag = state.sourceIdentityRelocation; if (tag === undefined) return;
  let auditDir = null;
  try {
    const keys = ["schemaVersion", "version", "policy", "operationId", "verifiedAt", "previousStateSha256", "previousPointerSha256", "verificationReceiptSha256"];
    need(tag && typeof tag === "object" && !Array.isArray(tag) && Object.keys(tag).length === keys.length && keys.every(key => Object.hasOwn(tag, key))
      && tag.schemaVersion === 1 && tag.version === VERSION && tag.policy === POLICY && UUID.test(tag.operationId || "") && H.validIso(tag.verifiedAt)
      && [tag.previousStateSha256, tag.previousPointerSha256, tag.verificationReceiptSha256].every(value => H.SHA.test(value || "")), "KEYWORD_SOURCE_RELOCATION_PRIOR_AUDIT_INVALID");
    auditDir = path.join(directory, "source-relocations", tag.operationId); const own = await checked(auditDir, true);
    need(process.platform === "win32" || own.uid === BigInt(process.getuid()) && (own.mode & 0o777n) === 0o700n, "KEYWORD_SOURCE_RELOCATION_PRIOR_AUDIT_INVALID");
    const verification = await readRaw(path.join(auditDir, "verification.json"), LIMITS.receiptBytes), complete = await readRaw(path.join(auditDir, "relocation-complete.json"), LIMITS.receiptBytes);
    need(verification.sha256 === tag.verificationReceiptSha256, "KEYWORD_SOURCE_RELOCATION_PRIOR_AUDIT_INVALID");
    const proof = JSON.parse(verification.bytes), receipt = JSON.parse(complete.bytes);
    for (const row of [proof, receipt]) need(row.schemaVersion === 1 && row.version === VERSION && row.operationId === tag.operationId
      && row.previousStateSha256 === tag.previousStateSha256 && row.previousPointerSha256 === tag.previousPointerSha256, "KEYWORD_SOURCE_RELOCATION_PRIOR_AUDIT_INVALID");
    need(proof.policy === POLICY && proof.verifiedAt === tag.verifiedAt && receipt.status === "relocated" && receipt.verificationReceiptSha256 === verification.sha256
      && H.SHA.test(receipt.stateSha256 || "") && H.SHA.test(receipt.pointerSha256 || ""), "KEYWORD_SOURCE_RELOCATION_PRIOR_AUDIT_INVALID");
    // Normal context preparation advances the current state. The complete
    // receipt binds the original relocation, not every later state generation.
  } catch (cause) {
    throw Object.assign(new Error("KEYWORD_SOURCE_RELOCATION_NEEDS_READBACK", { cause }), { code: "KEYWORD_SOURCE_RELOCATION_NEEDS_READBACK",
      operationId: UUID.test(tag?.operationId || "") ? tag.operationId : null, auditDir, mutationState: "prior_source_relocation_audit_unverified", sourceWrites: 0, providerCalls: 0 });
  }
}
async function relocateKeywordMonthlySources(options, dependencies = {}) {
  const { dataDir, expectedStateSha256, expectedPointerSha256, operationId, assertExclusive, admission = async () => {},
    outbox = createKeywordMonthlySourceDelta({ dataDir }), now = () => new Date() } = options || {};
  H.absolute(dataDir); need(H.SHA.test(expectedStateSha256 || "") && H.SHA.test(expectedPointerSha256 || "") && UUID.test(operationId || "")
    && typeof assertExclusive === "function" && typeof admission === "function" && typeof now === "function"
    && typeof outbox?.listEvents === "function" && typeof outbox?.readEvent === "function", "KEYWORD_SOURCE_RELOCATION_ARGUMENT_INVALID");
  const monotonic = dependencies.monotonicNow || (() => require("node:perf_hooks").performance.now()), started = monotonic();
  const checkTime = () => { const elapsed = monotonic() - started;
    need(Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= LIMITS.milliseconds, "KEYWORD_SOURCE_RELOCATION_TIME_BOUND"); };
  const checkpoint = async (exclusive = true) => { checkTime();
    need(await admission() !== false, "KEYWORD_SOURCE_RELOCATION_ADMISSION_HOLD"); checkTime();
    if (exclusive) need(await assertExclusive() === true, "KEYWORD_SOURCE_RELOCATION_EXCLUSIVITY_UNVERIFIED"); checkTime(); };
  await checkpoint(); const store = S.createStore({ dataDir, now, admission: checkpoint }), current = await store.load();
  need(current && current.stateSha256 === expectedStateSha256 && current.pointerSha256 === expectedPointerSha256, "KEYWORD_SOURCE_RELOCATION_STATE_CHANGED");
  const directory = store.directory, pointerFile = path.join(directory, "source-current.json"), pointer = await readRaw(pointerFile, LIMITS.pointerBytes);
  need(pointer.sha256 === expectedPointerSha256, "KEYWORD_SOURCE_RELOCATION_STATE_CHANGED");
  await assertPriorAudit(directory, current.state); await checkpoint();
  const sourceFiles = { company: path.join(dataDir, "company_master", "companies.json"), history: path.join(dataDir, "history", "observations.jsonl") }, actual = {};
  for (const [name, file] of Object.entries(sourceFiles)) actual[name] = S.sourceStamp(await checked(file));
  // Ordinary same-device source updates belong to the unchanged strict delta
  // chain in createContext/apply, not to identity relocation. This result makes
  // no claim that source bytes or their non-device metadata are unchanged.
  if (Object.keys(sourceFiles).every(name => exactStamp(current.state.sourceStamps[name]) && current.state.sourceStamps[name].dev === actual[name].dev)) {
    await checkpoint(); need((await store.load()).pointerSha256 === expectedPointerSha256, "KEYWORD_SOURCE_RELOCATION_STATE_CHANGED");
    return { status: "unchanged", reasonCode: "SAME_DEVICE_DELTA_VALIDATION_DEFERRED", current: { stateSha256: current.stateSha256, pointerSha256: current.pointerSha256 }, receipt: null, originalBodyReads: 0, sourceWrites: 0, providerCalls: 0 };
  }
  for (const name of Object.keys(sourceFiles)) {
    const cached = current.state.sourceStamps[name], bootstrap = current.state.bootstrapSources[name];
    need(devOnly(cached, actual[name]) && devOnly(cached, bootstrap.sourceStamp), "KEYWORD_SOURCE_RELOCATION_NON_DEVICE_DRIFT");
    need(BigInt(actual[name].size) <= BigInt(LIMITS.sourceBytes) && Number(actual[name].size) === bootstrap.bytes, "KEYWORD_SOURCE_RELOCATION_SOURCE_BOUND");
  }
  const publicPointerFile = path.join(dataDir, "keyword_monthly_analysis", "current.json"), publicPointer = await readRaw(publicPointerFile, LIMITS.pointerBytes);
  const initialEvents = await outboxEvidence(outbox, current.state.appliedEvents, checkpoint), verified = {};
  for (const [name, file] of Object.entries(sourceFiles)) { await checkpoint(); verified[name] = await streamSource(file, actual[name], current.state.bootstrapSources[name], checkpoint); }
  const stable = async () => {
    await checkpoint(); need((await store.load()).pointerSha256 === expectedPointerSha256, "KEYWORD_SOURCE_RELOCATION_STATE_CHANGED");
    for (const [name, file] of Object.entries(sourceFiles)) need(sameStamp(actual[name], S.sourceStamp(await checked(file))), "KEYWORD_SOURCE_RELOCATION_SOURCE_CHANGED");
    need((await readRaw(publicPointerFile, LIMITS.pointerBytes)).sha256 === publicPointer.sha256, "KEYWORD_SOURCE_RELOCATION_PUBLIC_POINTER_CHANGED");
    need(JSON.stringify(await outboxEvidence(outbox, current.state.appliedEvents, checkpoint)) === JSON.stringify(initialEvents), "KEYWORD_SOURCE_RELOCATION_OUTBOX_CHANGED");
  };
  await stable(); const auditRoot = path.join(directory, "source-relocations"); await privateDirectory(auditRoot);
  const auditDir = path.join(auditRoot, operationId); await privateDirectory(auditDir, true);
  const originalPointer = await writeNew(path.join(auditDir, "original-pointer.json"), pointer.bytes);
  const verifiedAt = new Date(now()).toISOString(), verification = await writeNew(path.join(auditDir, "verification.json"), bytesFor({
    schemaVersion: 1, version: VERSION, policy: POLICY, operationId, verifiedAt, previousStateSha256: expectedStateSha256, previousPointerSha256: expectedPointerSha256,
    originalPointerSha256: originalPointer.sha256, publicPointerSha256: publicPointer.sha256, previousSourceStamps: current.state.sourceStamps,
    bootstrapSources: current.state.bootstrapSources, verifiedSources: verified, outbox: initialEvents, fullStreamBufferBytes: LIMITS.bufferBytes,
    sourceWrites: 0, providerCalls: 0, collectorStarted: false }));
  const next = structuredClone(current.state); next.sourceStamps = actual; next.generation++; next.updatedAt = verifiedAt;
  next.sourceIdentityRelocation = { schemaVersion: 1, version: VERSION, policy: POLICY, operationId, verifiedAt,
    previousStateSha256: expectedStateSha256, previousPointerSha256: expectedPointerSha256, verificationReceiptSha256: verification.sha256 };
  const nextStateSha256 = hash(bytesFor(next));
  await writeNew(path.join(auditDir, "relocation-intent.json"), bytesFor({ schemaVersion: 1, version: VERSION, status: "prepared", operationId,
    previousStateSha256: expectedStateSha256, previousPointerSha256: expectedPointerSha256, expectedNextStateSha256: nextStateSha256, verificationReceiptSha256: verification.sha256 }));
  await stable(); await checkpoint(); let saved;
  try {
    saved = await store.save(next, expectedPointerSha256);
    need(saved.stateSha256 === nextStateSha256, "KEYWORD_SOURCE_RELOCATION_READBACK_FAILED");
    need((await readRaw(publicPointerFile, LIMITS.pointerBytes)).sha256 === publicPointer.sha256, "KEYWORD_SOURCE_RELOCATION_PUBLIC_POINTER_CHANGED");
    await checkpoint(); const receipt = await writeNew(path.join(auditDir, "relocation-complete.json"), bytesFor({ schemaVersion: 1, version: VERSION, status: "relocated", operationId,
      previousStateSha256: expectedStateSha256, previousPointerSha256: expectedPointerSha256, stateSha256: saved.stateSha256, pointerSha256: saved.pointerSha256,
      verificationReceiptSha256: verification.sha256, originalPointerSha256: originalPointer.sha256, publicPointerSha256: publicPointer.sha256,
      originalBodyReads: 2, originalBytesRead: verified.company.bytes + verified.history.bytes, sourceWrites: 0, providerCalls: 0, collectorStarted: false, completedAt: new Date(now()).toISOString() }));
    return { status: "relocated", current: { stateSha256: saved.stateSha256, pointerSha256: saved.pointerSha256 }, receipt,
      originalBodyReads: 2, originalBytesRead: verified.company.bytes + verified.history.bytes, sourceWrites: 0, providerCalls: 0 };
  } catch (cause) {
    // save() can fail after rename/fsync/readback. An exact unchanged pointer
    // proves pre-promotion failure; anything else requires operator readback.
    if (!saved) { try { if ((await readRaw(pointerFile, LIMITS.pointerBytes)).sha256 === expectedPointerSha256) throw cause; }
      catch (error) { if (error === cause) throw error; } }
    throw Object.assign(new Error("KEYWORD_SOURCE_RELOCATION_NEEDS_READBACK", { cause }), { code: "KEYWORD_SOURCE_RELOCATION_NEEDS_READBACK",
      operationId, auditDir, expectedNextStateSha256: nextStateSha256, previousStateSha256: expectedStateSha256, previousPointerSha256: expectedPointerSha256,
      mutationState: "source_checkpoint_promotion_uncertain", sourceWrites: 0, providerCalls: 0 });
  }
}
module.exports = { relocateKeywordMonthlySources, KEYWORD_MONTHLY_SOURCE_RELOCATION_VERSION: VERSION, KEYWORD_MONTHLY_SOURCE_RELOCATION_LIMITS: LIMITS };
