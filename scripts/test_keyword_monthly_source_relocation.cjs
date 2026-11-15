"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), zlib = require("node:zlib");
const S = require("./lib/keyword_monthly_incremental_state.cjs"), { createKeywordMonthlySourceDelta } = require("./lib/keyword_monthly_source_delta.cjs");
const { relocateKeywordMonthlySources: relocate, KEYWORD_MONTHLY_SOURCE_RELOCATION_LIMITS: LIMITS } = require("./lib/keyword_monthly_source_relocation.cjs");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), clone = value => JSON.parse(JSON.stringify(value));
const NOW = "2026-11-16T01:00:00.000Z", operationId = () => crypto.randomUUID();
async function fixture(t, { deviceChanged = true, priorDeviceDifference = false, changeState = null } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-source-relocation-"));
  t.after(async () => { assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); assert.ok(path.basename(dataDir).startsWith("keyword-source-relocation-")); await fs.rm(dataDir, { recursive: true, force: true }); });
  for (const name of ["company_master", "history", "keyword_monthly_analysis", "issued"]) await fs.mkdir(path.join(dataDir, name));
  const companyFile = path.join(dataDir, "company_master/companies.json"), historyFile = path.join(dataDir, "history/observations.jsonl"), publicFile = path.join(dataDir, "keyword_monthly_analysis/current.json"), issuedFile = path.join(dataDir, "issued/preserve.json");
  await fs.writeFile(companyFile, JSON.stringify({ schemaVersion: 1, companies: { a: { companyId: "a", primaryName: "SECRET COMPANY", price: 9123456 } } }));
  await fs.writeFile(historyFile, JSON.stringify({ companyKey: "a", runId: "r1", stayDate: "2026-11-20", productType: "lodging", sold: 1 }) + "\n");
  await fs.writeFile(publicFile, '{"generation":"keep-public"}'); await fs.writeFile(issuedFile, '{"issued":"keep-issue"}');
  const outbox = createKeywordMonthlySourceDelta({ dataDir }), stamp = S.sourceStamp(await fs.lstat(historyFile, { bigint: true }));
  const event = await outbox.recordHistoryDelta({ rows: [], sourceStamp: { before: stamp, after: stamp }, indexUpdated: true, runId: "bootstrap" }); assert.equal(event.status, "complete");
  const store = S.createStore({ dataDir, now: () => new Date(NOW) }), boot = await store.bootstrap({ eventIds: [event.eventId], projectCompany: raw => ({ companyId: raw.companyId }) });
  const state = clone(boot.state); state.lastPublished = { stateSha256: "a".repeat(64), sourceKey: "b".repeat(64), generation: "c".repeat(32), pointerSha256: "d".repeat(64) };
  if (deviceChanged) for (const name of ["company", "history"]) {
    const actual = BigInt(state.sourceStamps[name].dev); state.sourceStamps[name].dev = String(actual + 1n); state.bootstrapSources[name].sourceStamp.dev = String(actual + (priorDeviceDifference ? 2n : 1n));
  }
  if (changeState) changeState(state);
  const raw = Buffer.from(JSON.stringify(state)), stateSha256 = hash(raw), compressed = zlib.gzipSync(raw), stateFile = path.join(store.directory, "states", stateSha256 + ".json.gz");
  await fs.writeFile(stateFile, compressed, { flag: "wx", mode: 0o600 });
  const pointerFile = path.join(store.directory, "source-current.json"), pointer = Buffer.from(JSON.stringify({ schemaVersion: 1, version: S.VERSION, stateSha256, compression: "gzip", storageSha256: hash(compressed), storageBytes: compressed.length, rawBytes: raw.length, generation: state.generation, createdAt: NOW }));
  await fs.writeFile(pointerFile, pointer); const id = operationId();
  const originals = await Promise.all([companyFile, historyFile, publicFile, issuedFile].map(file => fs.readFile(file)));
  const options = { dataDir, expectedStateSha256: stateSha256, expectedPointerSha256: hash(pointer), operationId: id, assertExclusive: async () => true, admission: async () => {}, outbox, now: () => new Date(NOW) };
  return { dataDir, companyFile, historyFile, publicFile, issuedFile, outbox, store, state, stateSha256, compressed, stateFile, pointerFile, pointer, options,
    auditDir: path.join(store.directory, "source-relocations", id), originals,
    async preserve({ pointerUnchanged = false } = {}) { const files = await Promise.all([companyFile, historyFile, publicFile, issuedFile].map(file => fs.readFile(file))); assert.deepEqual(files, originals); assert.deepEqual(await fs.readFile(stateFile), compressed); if (pointerUnchanged) assert.deepEqual(await fs.readFile(pointerFile), pointer); } };
}
function patched(t, owner, key, replace) { const old = owner[key]; owner[key] = replace(old); t.after(() => { owner[key] = old; }); }
const exists = file => fs.access(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const preservedState = state => Object.fromEntries(Object.entries(state).filter(([key]) => !["sourceStamps", "generation", "updatedAt", "sourceIdentityRelocation"].includes(key)));

test("dev-only relocation rehashes both bodies, archives exact pointer bytes, preserves all non-identity state and public/issued files", async t => {
  const f = await fixture(t), opens = []; patched(t, fs, "open", original => async (file, ...args) => { if ([f.companyFile, f.historyFile].includes(file)) { assert.equal(args[0] & 3, 0); opens.push(file); } return original(file, ...args); });
  const result = await relocate(f.options); assert.equal(result.status, "relocated"); assert.deepEqual(opens, [f.companyFile, f.historyFile]); assert.equal(result.originalBodyReads, 2);
  assert.equal(result.originalBytesRead, f.originals[0].length + f.originals[1].length); assert.equal(result.sourceWrites, 0); assert.equal(result.providerCalls, 0);
  const current = await f.store.load(); assert.equal(current.stateSha256, result.current.stateSha256); assert.deepEqual(preservedState(current.state), preservedState(f.state));
  assert.deepEqual(current.state.bootstrapSources, f.state.bootstrapSources); assert.equal(current.state.generation, f.state.generation + 1);
  assert.deepEqual(current.state.sourceStamps.company, S.sourceStamp(await fs.lstat(f.companyFile, { bigint: true })));
  assert.deepEqual(current.state.sourceStamps.history, S.sourceStamp(await fs.lstat(f.historyFile, { bigint: true })));
  assert.equal(current.state.sourceIdentityRelocation.previousStateSha256, f.stateSha256);
  assert.deepEqual(await fs.readFile(path.join(f.auditDir, "original-pointer.json")), f.pointer);
  const receipt = await fs.readFile(result.receipt.file); assert.equal(hash(receipt), result.receipt.sha256); assert.equal(receipt.length, result.receipt.bytes);
  const audit = await fs.readFile(path.join(f.auditDir, "verification.json"), "utf8"); assert.ok(!audit.includes("SECRET COMPANY")); assert.ok(!audit.includes("9123456")); await f.preserve();
});
test("previous cached/bootstrap dev differences permit repeated deployment proof without rewriting bootstrap provenance", async t => {
  const f = await fixture(t, { priorDeviceDifference: true }); assert.notEqual(f.state.sourceStamps.company.dev, f.state.bootstrapSources.company.sourceStamp.dev);
  const result = await relocate(f.options), current = await f.store.load(); assert.equal(result.status, "relocated"); assert.deepEqual(current.state.bootstrapSources, f.state.bootstrapSources);
  assert.equal(current.state.sourceIdentityRelocation.previousPointerSha256, hash(f.pointer)); await f.preserve();
});
test("unchanged device defers ordinary fresh delta validation and never opens original bodies", async t => {
  const f = await fixture(t, { deviceChanged: false }); await fs.appendFile(f.historyFile, '{"legitimate":"new delta"}\n');
  patched(t, fs, "open", original => async (file, ...args) => { if ([f.companyFile, f.historyFile].includes(file)) assert.fail("body read on same device"); return original(file, ...args); });
  const result = await relocate(f.options); assert.equal(result.status, "unchanged"); assert.equal(result.reasonCode, "SAME_DEVICE_DELTA_VALIDATION_DEFERRED"); assert.equal(result.originalBodyReads, 0);
  assert.deepEqual(await fs.readFile(f.pointerFile), f.pointer); assert.equal(await exists(f.auditDir), false);
});
for (const field of ["ino", "size", "mtimeNs", "ctimeNs", "nlink"]) test(`non-dev ${field} drift never becomes relocation`, async t => {
  const f = await fixture(t, { changeState: state => { state.sourceStamps.history[field] = String(BigInt(state.sourceStamps.history[field]) + 1n); state.bootstrapSources.history.sourceStamp[field] = state.sourceStamps.history[field]; if (field === "size") state.bootstrapSources.history.bytes++; } });
  await assert.rejects(relocate(f.options), /KEYWORD_(?:SOURCE_RELOCATION_NON_DEVICE_DRIFT|INCREMENTAL_SOURCE_STAMP_INVALID|INCREMENTAL_BOOTSTRAP_SOURCE_INVALID)/); await f.preserve({ pointerUnchanged: true });
});
test("a post-bootstrap delta anchor difference holds even when cached/current differ only by dev", async t => {
  const f = await fixture(t, { changeState: state => { state.bootstrapSources.company.sourceStamp.ctimeNs = String(BigInt(state.bootstrapSources.company.sourceStamp.ctimeNs) - 1n); } });
  await assert.rejects(relocate(f.options), /NON_DEVICE_DRIFT/); await f.preserve({ pointerUnchanged: true });
});
test("full stream hashes, not size or inode alone, must equal each trusted bootstrap hash", async t => {
  const f = await fixture(t, { changeState: state => { state.bootstrapSources.history.sha256 = "0".repeat(64); } });
  await assert.rejects(relocate(f.options), /BOOTSTRAP_HASH_MISMATCH/); assert.equal(await exists(f.auditDir), false); await f.preserve({ pointerUnchanged: true });
});
test("fresh or missing outbox events hold before original-body reads", async t => {
  for (const variant of ["fresh", "missing"]) await t.test(variant, async st => {
    const f = await fixture(st); let outbox = f.outbox;
    if (variant === "fresh") { const stamp = S.sourceStamp(await fs.lstat(f.historyFile, { bigint: true })); await outbox.recordHistoryDelta({ rows: [], sourceStamp: { before: stamp, after: stamp }, indexUpdated: true, runId: "new-event" }); }
    else outbox = { ...outbox, listEvents: async () => ({ status: "available", inventorySha256: "a".repeat(64), events: [], incompleteEventIds: [], completeCount: 0, nextOffset: null }) };
    patched(st, fs, "open", original => async (file, ...args) => { if ([f.companyFile, f.historyFile].includes(file)) assert.fail("outbox hold read a body"); return original(file, ...args); });
    await assert.rejects(relocate({ ...f.options, outbox }), /OUTBOX_UNVERIFIED|DELTA_SET_CHANGED/); await f.preserve({ pointerUnchanged: true });
  });
});
for (const variant of ["descriptorHash", "bodyIdentity"]) test(`full readEvent ${variant} mismatch holds`, async t => {
  const f = await fixture(t), outbox = { ...f.outbox, readEvent: async id => { const read = await f.outbox.readEvent(id); return variant === "descriptorHash" ? { ...read, eventSha256: "0".repeat(64) } : { ...read, event: { ...read.event, payload: { ...read.event.payload, indexUpdated: false } } }; } };
  await assert.rejects(relocate({ ...f.options, outbox }), /EVENT_UNVERIFIED|EVENT_IDENTITY_CHANGED/); await f.preserve({ pointerUnchanged: true });
});
test("false, absent or throwing exclusive proof cannot mutate a pointer", async t => {
  for (const proof of [async () => false, async () => undefined, async () => { throw Object.assign(new Error("lease lost"), { code: "TEST_LEASE_LOST" }); }]) {
    const f = await fixture(t); await assert.rejects(relocate({ ...f.options, assertExclusive: proof }), /EXCLUSIVITY_UNVERIFIED|lease lost/); await f.preserve({ pointerUnchanged: true });
  }
});
test("lease loss immediately before commit keeps the old pointer and immutable audit intent", async t => {
  const f = await fixture(t), assertExclusive = async () => !await exists(path.join(f.auditDir, "relocation-intent.json"));
  await assert.rejects(relocate({ ...f.options, assertExclusive }), /EXCLUSIVITY_UNVERIFIED/); await f.preserve({ pointerUnchanged: true });
  assert.deepEqual(await fs.readFile(path.join(f.auditDir, "original-pointer.json")), f.pointer); assert.equal(await exists(path.join(f.auditDir, "relocation-complete.json")), false);
});
test("an admission hold after an audit intent prevents checkpoint promotion", async t => {
  const f = await fixture(t), admission = async () => !await exists(path.join(f.auditDir, "relocation-intent.json"));
  await assert.rejects(relocate({ ...f.options, admission }), /ADMISSION_HOLD/); await f.preserve({ pointerUnchanged: true });
});
test("the fifteen-minute budget is checked after a slow admission callback", async t => {
  const f = await fixture(t); let clock = 0;
  await assert.rejects(relocate({ ...f.options, admission: async () => { clock = LIMITS.milliseconds + 1; } }, { monotonicNow: () => clock }), /TIME_BOUND/); await f.preserve({ pointerUnchanged: true });
});
test("a pointer changed at the final boundary is never overwritten", async t => {
  const f = await fixture(t), raced = Buffer.concat([f.pointer, Buffer.from(" ")]); let changed = false;
  const assertExclusive = async () => { if (!changed && await exists(path.join(f.auditDir, "relocation-intent.json"))) { changed = true; await fs.writeFile(f.pointerFile, raced); } return true; };
  await assert.rejects(relocate({ ...f.options, assertExclusive }), /STATE_CHANGED/); assert.deepEqual(await fs.readFile(f.pointerFile), raced); await f.preserve();
});
test("a newly completed event at the final boundary prevents relocation", async t => {
  const f = await fixture(t); let changed = false;
  const assertExclusive = async () => { if (!changed && await exists(path.join(f.auditDir, "relocation-intent.json"))) { changed = true;
    const stamp = S.sourceStamp(await fs.lstat(f.historyFile, { bigint: true })); await f.outbox.recordHistoryDelta({ rows: [], sourceStamp: { before: stamp, after: stamp }, indexUpdated: true, runId: "raced-event" }); } return true; };
  await assert.rejects(relocate({ ...f.options, assertExclusive }), /OUTBOX_UNVERIFIED|DELTA_SET_CHANGED/); await f.preserve({ pointerUnchanged: true });
});
test("an existing audit directory is not reused or overwritten", async t => {
  const f = await fixture(t); await fs.mkdir(path.dirname(f.auditDir), { mode: 0o700 }); await fs.mkdir(f.auditDir, { mode: 0o700 }); const file = path.join(f.auditDir, "foreign.json"); await fs.writeFile(file, "preserve");
  await assert.rejects(relocate(f.options), /AUDIT_EXISTS/); assert.equal(await fs.readFile(file, "utf8"), "preserve"); await f.preserve({ pointerUnchanged: true });
});
test("an incomplete descriptor cannot authorize relocation even when the event body is complete", async t => {
  const f = await fixture(t), outbox = { ...f.outbox, listEvents: async input => { const result = await f.outbox.listEvents(input); return { ...result, events: result.events.map(row => ({ ...row, status: "pending" })) }; } };
  await assert.rejects(relocate({ ...f.options, outbox }), /EVENT_UNVERIFIED/); await f.preserve({ pointerUnchanged: true });
});
test("a completion receipt failure after checkpoint promotion reports controlled readback uncertainty without rollback", async t => {
  const f = await fixture(t), completeFile = path.join(f.auditDir, "relocation-complete.json");
  patched(t, fs, "open", original => async (file, ...args) => { if (file === completeFile && args[0] === "wx") throw Object.assign(new Error("fixture receipt failure"), { code: "ENOSPC" }); return original(file, ...args); });
  const error = await relocate(f.options).then(() => assert.fail("receipt write must fail"), error => error);
  assert.equal(error.code, "KEYWORD_SOURCE_RELOCATION_NEEDS_READBACK"); assert.equal(error.cause.code, "ENOSPC"); assert.equal(error.operationId, f.options.operationId);
  assert.equal(error.auditDir, f.auditDir); assert.equal(error.mutationState, "source_checkpoint_promotion_uncertain");
  const current = await f.store.load(); assert.equal(current.stateSha256, error.expectedNextStateSha256); assert.notEqual(current.pointerSha256, hash(f.pointer));
  assert.deepEqual(await fs.readFile(path.join(f.auditDir, "original-pointer.json")), f.pointer);
  assert.equal(await exists(path.join(f.auditDir, "relocation-intent.json")), true); assert.equal(await exists(completeFile), false);
  await assert.rejects(relocate({ ...f.options, operationId: operationId(), expectedStateSha256: current.stateSha256, expectedPointerSha256: current.pointerSha256 }),
    error => error.code === "KEYWORD_SOURCE_RELOCATION_NEEDS_READBACK" && error.mutationState === "prior_source_relocation_audit_unverified"); await f.preserve();
});
test("completed relocation proof remains valid after normal state preparation advances the checkpoint", async t => {
  const f = await fixture(t); await relocate(f.options); const relocated = await f.store.load(), state = clone(relocated.state);
  state.generation++; state.lastPreparedAt = "2026-11-16T01:01:00.000Z"; const prepared = await f.store.save(state, relocated.pointerSha256);
  const result = await relocate({ ...f.options, operationId: operationId(), expectedStateSha256: prepared.stateSha256, expectedPointerSha256: prepared.pointerSha256 });
  assert.equal(result.status, "unchanged"); assert.equal(result.originalBodyReads, 0); assert.equal(result.current.stateSha256, prepared.stateSha256); await f.preserve();
});
test("malformed or changed prior completion proof holds rather than returning same-device unchanged", async t => {
  for (const variant of ["complete", "verification"]) await t.test(variant, async st => {
    const f = await fixture(st); await relocate(f.options); const current = await f.store.load(), file = path.join(f.auditDir, variant === "complete" ? "relocation-complete.json" : "verification.json");
    const value = JSON.parse(await fs.readFile(file, "utf8")); value.operationId = operationId(); await fs.writeFile(file, JSON.stringify(value));
    await assert.rejects(relocate({ ...f.options, operationId: operationId(), expectedStateSha256: current.stateSha256, expectedPointerSha256: current.pointerSha256 }), /NEEDS_READBACK/);
    assert.equal((await f.store.load()).pointerSha256, current.pointerSha256); await f.preserve();
  });
});
