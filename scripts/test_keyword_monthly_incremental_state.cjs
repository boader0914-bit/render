"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), zlib = require("node:zlib");
const { createStore, sourceStamp, MAX_STATE, BOOTSTRAP_LIMITS, PERSISTENT_LIMITS } = require("./lib/keyword_monthly_incremental_state.cjs");
const { events: readContextEvents, createContext, companyDependencyKeywords } = require("./lib/keyword_monthly_incremental_context.cjs");
const { createKeywordMonthlySourceDelta } = require("./lib/keyword_monthly_source_delta.cjs");
const sha = value => crypto.createHash("sha256").update(value).digest("hex"), clone = value => JSON.parse(JSON.stringify(value));
const company = (companyId, extra = {}) => ({ companyId, primaryName: companyId, placeIds: [companyId + "-place"], keywords: {}, inventory: {}, ...extra });
const row = (n, extra = {}) => ({ companyKey: "a", observationId: n, runId: "run_" + n, stayDate: "2026-11-20", collectedAt: "2026-11-15T01:00:00Z", productType: "lodging", sold: n, ...extra });
const project = raw => ({ companyId: raw.companyId, primaryName: raw.primaryName, placeIds: raw.placeIds || [], manualCorrection: raw.manualCorrection || null, mergedIntoCompanyId: raw.mergedIntoCompanyId || null });
function event(kind, payload, n = 1) { return { schemaVersion: 1, eventId: sha(JSON.stringify({ schemaVersion: 1, kind, payload })), kind, payload, createdAt: `2026-11-15T01:00:${String(n).padStart(2, "0")}.000Z` }; }
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-incremental-state-"));
  t.after(async () => { assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dataDir, { recursive: true, force: true }); });
  await fs.mkdir(path.join(dataDir, "company_master")); await fs.mkdir(path.join(dataDir, "history"));
  const masterFile = path.join(dataDir, "company_master", "companies.json"), historyFile = path.join(dataDir, "history", "observations.jsonl");
  const master = { schemaVersion: 1, companies: { a: company("a"), b: company("b") } };
  await fs.writeFile(masterFile, JSON.stringify(master)); await fs.writeFile(historyFile, [row(1), row(2)].map(JSON.stringify).join("\n") + "\n");
  const make = extra => createStore({ dataDir, now: () => new Date("2026-11-15T02:00:00Z"), ...options, ...extra });
  const store = make(), pointerFile = path.join(store.directory, "source-current.json");
  return { dataDir, masterFile, historyFile, master, store, make, pointerFile,
    bootstrap: () => store.bootstrap({ projectCompany: project }), pointer: () => fs.readFile(pointerFile),
    async companyEvent(changes, order, n = 1) {
      const before = sourceStamp(await fs.lstat(masterFile, { bigint: true }));
      for (const change of changes) if (change.company === null) delete master.companies[change.companyId]; else master.companies[change.companyId] = clone(change.company);
      master.companies = Object.fromEntries(order.map(id => [id, master.companies[id]]));
      await fs.writeFile(masterFile, JSON.stringify(master));
      return event("companies", { changes, order, sourceStamp: { before, after: sourceStamp(await fs.lstat(masterFile, { bigint: true })) } }, n);
    },
    async historyEvent(rows, n = 1, indexUpdated = true) {
      const before = sourceStamp(await fs.lstat(historyFile, { bigint: true })); await fs.appendFile(historyFile, rows.map(JSON.stringify).join("\n") + "\n");
      return event("history", { runId: "run_" + n, rows, indexUpdated, sourceStamp: { before, after: sourceStamp(await fs.lstat(historyFile, { bigint: true })) } }, n);
    } };
}
function patch(t, owner, key, replacement) { const before = owner[key]; owner[key] = replacement(before); t.after(() => { owner[key] = before; }); }
async function rowsOf(store, state, query = {}) { const rows = []; await store.createHistoryReader(state).readRows(query, (row, ordinal) => rows.push({ row, ordinal })); return rows; }

test("explicit bootstrap reads each original body once, preserves raw order, and restart uses only private blobs", async t => {
  const f = await fixture(t), reads = { master: 0, history: 0 }; let forbid = false;
  patch(t, native, "createReadStream", original => (file, ...args) => {
    if (file === f.masterFile || file === f.historyFile) { assert.equal(forbid, false, "Delta operation reread an original body"); reads[file === f.masterFile ? "master" : "history"]++; }
    return original(file, ...args);
  });
  const first = await f.bootstrap(); assert.deepEqual(reads, { master: 1, history: 1 }); assert.equal(first.state.history.rows, 2);
  assert.equal(f.store.counters.originalMasterBodyReads, 1); assert.equal(f.store.counters.originalHistoryBodyReads, 1);
  assert.deepEqual(first.state.companies.map(e => e.companyId), ["a", "b"]); forbid = true;
  const resumed = f.make(), loaded = await resumed.load(); await resumed.assertSources(loaded.state);
  assert.deepEqual(await resumed.readCompany("a", loaded.state.companies[0]), f.master.companies.a);
  assert.deepEqual((await rowsOf(resumed, loaded.state)).map(e => e.row.observationId), [1, 2]);
  const fresh = await f.historyEvent([row(3)]), updated = await resumed.apply({ current: loaded, events: [fresh], projectCompany: project });
  assert.equal(updated.state.history.rows, 3); assert.equal(resumed.counters.originalMasterBodyReads, 0); assert.equal(resumed.counters.originalHistoryBodyReads, 0); assert.deepEqual(reads, { master: 1, history: 1 });
});

test("late out-of-order events follow exact source stamps and preserve intermediate observations", async t => {
  const f = await fixture(t), current = await f.bootstrap(), a = await f.historyEvent([row(3)], 1), b = await f.historyEvent([row(4)], 2);
  const next = await f.store.apply({ current, events: [b, a], projectCompany: project });
  assert.deepEqual((await rowsOf(f.store, next.state)).map(e => e.row.observationId), [1, 2, 3, 4]);
  assert.deepEqual(next.state.appliedEvents.slice(-2), [a.eventId, b.eventId]); assert.equal(current.state.history.rows, 2);
});

test("repeated events within one delivery and after restart never duplicate rows", async t => {
  const f = await fixture(t), current = await f.bootstrap(), fresh = await f.historyEvent([row(3)]);
  const next = await f.store.apply({ current, events: [fresh, clone(fresh)], projectCompany: project }); assert.equal(next.state.history.rows, 3);
  const resumed = f.make(), repeated = await resumed.apply({ current: await resumed.load(), events: [fresh], projectCompany: project });
  assert.equal(repeated.state.history.rows, 3); assert.equal(repeated.state.appliedEvents.filter(id => id === fresh.eventId).length, 1); assert.equal(resumed.counters.deltaHistoryRows, 0);
});

test("raw corrections, aliases, deletion and order-only changes survive without original-body fallback", async t => {
  const f = await fixture(t), current = await f.bootstrap(); let originalOpens = 0;
  patch(t, native, "createReadStream", original => (file, ...args) => { if ([f.masterFile, f.historyFile].includes(file)) { originalOpens++; throw Error("Original body fallback forbidden"); } return original(file, ...args); });
  const edited = company("a", { manualCorrection: { lodgingBasisTotal: 17 }, duplicateNotes: [{ mergedCompanyId: "b" }], keywords: { later: { keyword: "후" }, earlier: { keyword: "전" } } });
  const fresh = await f.companyEvent([{ companyId: "a", company: edited, orderIndex: 0 }, { companyId: "b", company: null, orderIndex: 1 }], ["a"]);
  const next = await f.store.apply({ current, events: [fresh], projectCompany: project }); assert.deepEqual(next.state.companies.map(e => e.companyId), ["a"]);
  assert.deepEqual(await f.store.readCompany("a", next.state.companies[0]), edited); assert.equal(next.state.companies[0].compact.manualCorrection.lodgingBasisTotal, 17);
  assert.ok(next.state.dirtyCompanyIds.includes("a") && next.state.dirtyCompanyIds.includes("b")); assert.equal(originalOpens, 0);
  const orderOnly = await f.companyEvent([], ["a"], 2), again = await f.store.apply({ current: next, events: [orderOnly], projectCompany: project });
  assert.deepEqual(await f.store.readCompany("a", again.state.companies[0]), edited); assert.equal(again.state.companies[0].sha256, next.state.companies[0].sha256);
});

test("source forks, gaps and unindexed history hold while the old pointer remains byte-identical", async t => {
  for (const kind of ["fork", "gap", "unindexed"]) await t.test(kind, async st => {
    const f = await fixture(st), current = await f.bootstrap(), pointer = await f.pointer(), fresh = await f.historyEvent([row(3)]);
    let events, code;
    if (kind === "fork") { const alternative = clone(fresh); alternative.payload.rows[0].sold = 99; alternative.eventId = sha("fork"); events = [fresh, alternative]; code = "KEYWORD_INCREMENTAL_DELTA_FORK"; }
    if (kind === "gap") { fresh.payload.sourceStamp.before.size = "999999"; events = [fresh]; code = "KEYWORD_INCREMENTAL_DELTA_GAP"; }
    if (kind === "unindexed") { fresh.payload.indexUpdated = false; events = [fresh]; code = "KEYWORD_INCREMENTAL_HISTORY_NOT_INDEXED"; }
    await assert.rejects(f.store.apply({ current, events, projectCompany: project }), { code });
    assert.deepEqual(await f.pointer(), pointer); assert.equal((await f.store.load()).state.history.rows, 2); assert.equal(current.state.history.rows, 2);
  });
});

test("a partial multi-event failure preserves current state even after writing a new private blob", async t => {
  const f = await fixture(t), current = await f.bootstrap(), old = clone(current), pointer = await f.pointer();
  const changed = await f.companyEvent([{ companyId: "a", company: company("a", { primaryName: "changed" }), orderIndex: 0 }], ["a", "b"]);
  const gap = await f.historyEvent([row(3)]); gap.payload.sourceStamp.before.ino = "999999999999";
  await assert.rejects(f.store.apply({ current, events: [changed, gap], projectCompany: project }), { code: "KEYWORD_INCREMENTAL_DELTA_GAP" });
  assert.deepEqual(current, old); assert.deepEqual(await f.pointer(), pointer); assert.equal((await f.store.load()).stateSha256, current.stateSha256);
});

test("source stamp requires exact nonnegative integer strings and rejects missing identity fields", async t => {
  const f = await fixture(t), current = await f.bootstrap();
  for (const invalid of [{}, { dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5" },
    { dev: "1", ino: "2", size: "-1", mtimeNs: "4", ctimeNs: "5", nlink: "1" },
    { dev: "1", ino: "2", size: 3, mtimeNs: "4", ctimeNs: "5", nlink: "1" }]) {
    const state = clone(current.state); state.sourceStamps.company = invalid; assert.throws(() => f.store.validate(state), /KEYWORD_INCREMENTAL/);
  }
  assert.throws(() => sourceStamp({ dev: 1n }), /KEYWORD_INCREMENTAL/);
});

test("immutable wx writes and child-directory sync precede publication of the state pointer", async t => {
  const f = await fixture(t), trace = [];
  // Exercise the Linux durability contract on Windows with explicit mock
  // directory handles. This proves call ordering, not Windows/Linux kernel IO.
  const platform = Object.getOwnPropertyDescriptor(process, "platform"), windows = process.platform === "win32";
  if (windows) { Object.defineProperty(process, "platform", { ...platform, value: "linux" }); t.after(() => Object.defineProperty(process, "platform", platform)); }
  patch(t, fs, "open", original => async (file, flags, ...args) => {
    if (windows && (await fs.lstat(file).catch(() => null))?.isDirectory()) {
      trace.push(["open", file, flags]); return { sync: async () => { trace.push(["sync", file]); }, close: async () => {} };
    }
    const handle = await original(file, flags, ...args); trace.push(["open", file, flags]);
    return new Proxy(handle, { get(target, key) {
      if (key === "sync") return async () => { trace.push(["sync", file]); return target.sync(); };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  patch(t, fs, "rename", original => async (from, to) => { trace.push(["rename", from, to]); return original(from, to); });
  await f.bootstrap(); const promoted = trace.findIndex(e => e[0] === "rename" && e[2] === f.pointerFile); assert.ok(promoted > 0);
  const privateWrites = trace.filter(e => e[0] === "open" && typeof e[2] === "string" && /[wa]/.test(e[2]));
  assert.ok(privateWrites.length > 0); assert.ok(privateWrites.every(e => e[2] === "wx"));
  for (const directory of [f.store.blobDir, f.store.historyDir, path.join(f.store.directory, "states")]) {
    assert.ok(trace.slice(0, promoted).some(e => e[0] === "sync" && e[1] === directory), `Missing pre-publication directory fsync: ${path.basename(directory)}`);
  }
  assert.ok(trace.slice(promoted + 1).some(e => e[0] === "sync" && e[1] === f.store.directory));
});

test("an immutable content conflict is preserved and cannot overwrite a successful company blob", async t => {
  const f = await fixture(t), current = await f.bootstrap(), first = current.state.companies[0], file = path.join(f.store.blobDir, first.sha256 + ".json.gz"), pointer = await f.pointer();
  await fs.writeFile(file, "corrupt-private-blob"); const corrupted = await fs.readFile(file);
  await assert.rejects(f.store.putCompany(f.master.companies.a), { code: "KEYWORD_INCREMENTAL_IMMUTABLE_CONFLICT" });
  assert.deepEqual(await fs.readFile(file), corrupted); assert.deepEqual(await f.pointer(), pointer);
});

test("pointer conflict and rename failure retain the previous successful pointer and authoritative sources", async t => {
  const f = await fixture(t), current = await f.bootstrap(), pointer = await f.pointer(), state = clone(current.state); state.generation++;
  await assert.rejects(f.store.save(state, "f".repeat(64)), { code: "KEYWORD_INCREMENTAL_STATE_POINTER_CHANGED" }); assert.deepEqual(await f.pointer(), pointer);
  const sourceBefore = [await fs.readFile(f.masterFile), await fs.readFile(f.historyFile)];
  patch(t, fs, "rename", original => async (from, to) => { if (to === f.pointerFile) throw Object.assign(Error("private rename failure"), { code: "EIO" }); return original(from, to); });
  await assert.rejects(f.store.save(state, current.pointerSha256), { code: "EIO" });
  assert.deepEqual(await f.pointer(), pointer); assert.deepEqual(await fs.readFile(f.masterFile), sourceBefore[0]); assert.deepEqual(await fs.readFile(f.historyFile), sourceBefore[1]);
});

test("source drift at final admission cannot publish a stale source checkpoint", async t => {
  const f = await fixture(t), current = await f.bootstrap(), fresh = await f.historyEvent([row(3)]), pointer = await f.pointer(); let admissions = 0;
  const store = f.make({ admission: async () => { if (++admissions === 2) await fs.appendFile(f.masterFile, " "); } });
  await assert.rejects(store.apply({ current, events: [fresh], projectCompany: project }), { code: "KEYWORD_INCREMENTAL_SOURCE_DRIFT_REQUIRES_BOOTSTRAP" });
  assert.deepEqual(await f.pointer(), pointer);
});

test("a pointer changed during temporary-file preparation is preserved instead of overwritten", async t => {
  const f = await fixture(t), current = await f.bootstrap(), state = clone(current.state), other = JSON.parse(await f.pointer());
  state.generation++; other.createdAt = "2026-11-16T00:00:00Z"; const winning = Buffer.from(JSON.stringify(other)); let raced = false;
  patch(t, fs, "open", original => async (file, flags, ...args) => {
    if (!raced && path.basename(file).startsWith("source-current-") && flags === "wx") { raced = true; await fs.writeFile(f.pointerFile, winning); }
    return original(file, flags, ...args);
  });
  await assert.rejects(f.store.save(state, current.pointerSha256), { code: "KEYWORD_INCREMENTAL_STATE_POINTER_CHANGED" });
  assert.equal(raced, true); assert.deepEqual(await f.pointer(), winning);
});

test("missing/corrupt referenced state never becomes an empty checkpoint or automatic bootstrap permission", async t => {
  const f = await fixture(t), current = await f.bootstrap(), file = path.join(f.store.directory, "states", current.stateSha256 + ".json.gz");
  await fs.writeFile(file, "{}"); await assert.rejects(f.store.load());
  await assert.rejects(f.store.bootstrap({ projectCompany: project })); assert.ok((await fs.readFile(f.pointerFile)).length > 0);
});

test("context inventory accepts real successful outbox metadata and rejects incomplete events", async t => {
  const f = await fixture(t), outbox = createKeywordMonthlySourceDelta({ dataDir: f.dataDir });
  const empty = await readContextEvents(outbox); assert.deepEqual(empty.descriptors, []);
  const recorded = await outbox.recordHistoryDelta({ runId: "run_3", rows: [row(3)], sourceStamp: { before: null, after: { value: "fixture" } }, indexUpdated: true });
  assert.equal(recorded.status, "complete"); const saved = await readContextEvents(outbox); assert.equal(saved.descriptors.length, 1); assert.equal(saved.descriptors[0].payloadValidated, false);
  const pendingFile = path.join(outbox.directory, "complete", recorded.eventId + ".json"); await fs.rename(pendingFile, pendingFile.slice(0, -5) + ".tmp");
  await assert.rejects(readContextEvents(outbox), { code: "KEYWORD_INCREMENTAL_OUTBOX_INCOMPLETE" });
});

test("context restart preserves preparation keys and reads only new company blobs after a raw delta", async t => {
  const f = await fixture(t), outputs = { root: path.join(f.dataDir, "outputs"), files: [] }, codeRoot = path.resolve(__dirname, ".."); let work = 0;
  await fs.mkdir(outputs.root);
  // Each production normalization owns a fresh work copy of saved sidecars.
  const create = async capturedAt => { const workDataDir = path.join(f.dataDir, "work-" + ++work); await fs.mkdir(workDataDir);
    return createContext({ dataDir: f.dataDir, codeRoot, workDataDir, capturedAt, outputs, runs: [], regions: [] }); };
  const first = await create("2026-11-15T02:00:00Z"); assert.equal(first.bootstrap, true);
  assert.equal(first.store.counters.originalMasterBodyReads, 1); assert.equal(first.store.counters.originalHistoryBodyReads, 1);
  const keys = first.state.companies.map(e => e.preparationKey), second = await create("2026-11-15T02:00:01Z");
  assert.equal(second.bootstrap, false); assert.equal(second.store.counters.companyBlobReads, 0);
  assert.equal(second.store.counters.originalMasterBodyReads, 0); assert.equal(second.store.counters.originalHistoryBodyReads, 0);
  assert.deepEqual(second.state.companies.map(e => e.preparationKey), keys); assert.equal(second.dependencyChanged, false);
  const delta = await f.companyEvent([{ companyId: "a", company: company("a", { primaryName: "raw edit" }), orderIndex: 0 }], ["a", "b"]);
  const outbox = createKeywordMonthlySourceDelta({ dataDir: f.dataDir }); assert.equal((await outbox.recordCompanyDelta(delta.payload)).status, "complete");
  const third = await create("2026-11-15T02:00:02Z"); assert.equal(third.store.counters.companyBlobReads, 1);
  assert.equal(third.store.counters.originalMasterBodyReads, 0); assert.equal(third.store.counters.originalHistoryBodyReads, 0);
  assert.notEqual(third.state.companies[0].preparationKey, keys[0]); assert.equal(third.state.companies[1].preparationKey, keys[1]);
});

test("company dependency metadata includes alias/place conflicts, removed IDs and run-keyword fallback", () => {
  const companies = [
    { companyId: "a", compact: { companyId: "a", placeIds: ["11"], duplicateNotes: [{ mergedCompanyId: "old-a" }], keywords: {} } },
    { companyId: "b", compact: { companyId: "b", placeIds: ["11"], keywords: {} } },
    { companyId: "c", compact: { companyId: "c", placeIds: ["33"], keywords: {} } }
  ];
  const partitions = [
    { companyKey: "old-a", keywords: ["legacy-alias"], runIds: ["old"] },
    { companyKey: "provider-other", placeId: "11", keywords: ["legacy-place"], runIds: [] },
    { companyKey: "b", keywords: ["duplicate-place-company"], runIds: [] },
    { companyKey: "removed", keywords: ["removed-history"], runIds: [] },
    { companyKey: "c", keywords: ["unrelated"], runIds: [] }
  ];
  const actual = companyDependencyKeywords({ companies, companyIds: ["a", "removed"], partitions, runs: [{ id: "old", keyword: "fallback-from-run" }] });
  assert.deepEqual(actual, ["legacy-alias", "fallback-from-run", "legacy-place", "duplicate-place-company", "removed-history"]);
});

test("a legacy company correction dirties its historical keyword even with no master keyword exposure", async t => {
  const f = await fixture(t), codeRoot = path.resolve(__dirname, ".."), outputs = { root: path.join(f.dataDir, "outputs"), files: [] };
  await fs.mkdir(outputs.root);
  await fs.writeFile(f.historyFile, JSON.stringify(row(1, { keyword: "legacy-history-keyword", rawTotal: 5, inventoryEvidenceVersion: 3 })) + "\n");
  const runs = [{ id: "run_1", keyword: "legacy-run-keyword", collectedAt: "2026-11-15T01:00:00Z", collectedAtSource: "manifest", collectionQuality: { status: "complete" } }];
  let work = 0;
  const create = async capturedAt => { const workDataDir = path.join(f.dataDir, "legacy-work-" + ++work); await fs.mkdir(workDataDir);
    return createContext({ dataDir: f.dataDir, codeRoot, workDataDir, capturedAt, outputs, runs, regions: [] }); };
  const first = await create("2026-11-15T02:00:00Z");
  await first.store.save({ ...first.state, dirtyCompanyIds: [], dirtyKeywords: [], dirtyMonths: [], globalDiagnosticsDirty: false }, first.current.pointerSha256);
  const delta = await f.companyEvent([{ companyId: "a", company: company("a", { manualCorrection: { lodgingBasisTotal: 7 } }), orderIndex: 0 }], ["a", "b"]);
  const outbox = createKeywordMonthlySourceDelta({ dataDir: f.dataDir }); assert.equal((await outbox.recordCompanyDelta(delta.payload)).status, "complete");
  const changed = await create("2026-11-15T02:00:01Z");
  assert.deepEqual(changed.state.companies[0].compact.keywords, {});
  assert.ok(changed.state.dirtyKeywords.includes("legacy-history-keyword"));
  assert.ok(changed.state.dirtyKeywords.includes("legacy-run-keyword"));
  assert.equal(changed.store.counters.originalMasterBodyReads, 0); assert.equal(changed.store.counters.originalHistoryBodyReads, 0);
  assert.equal(changed.store.counters.companyBlobReads, 1);
});

test("state gzip storage preserves raw JSON SHA identity and declares exact compressed/raw bytes", async t => {
  const f = await fixture(t), current = await f.bootstrap(), state = clone(current.state);
  state.generation++; state.companies[0].compact.fixtureRepeatedMetadata = "saved-state-metadata-".repeat(50000);
  const raw = Buffer.from(JSON.stringify(state)), expectedRawSha = sha(raw), saved = await f.store.save(state, current.pointerSha256);
  const pointer = JSON.parse(await f.pointer()), file = path.join(f.store.directory, "states", expectedRawSha + ".json.gz"), stored = await fs.readFile(file);
  assert.equal(saved.stateSha256, expectedRawSha); assert.equal(pointer.stateSha256, expectedRawSha); assert.equal(pointer.compression, "gzip");
  assert.equal(pointer.storageSha256, sha(stored)); assert.equal(pointer.storageBytes, stored.length); assert.equal(pointer.rawBytes, raw.length);
  assert.ok(stored.length < raw.length / 10); assert.deepEqual(zlib.gunzipSync(stored), raw); assert.deepEqual(saved.state, state);
  assert.equal((await fs.readdir(path.join(f.store.directory, "states"))).some(name => name.endsWith(".json")), false);
  const before = await fs.readFile(file), beforeStamp = await fs.lstat(file); await f.store.save(state, saved.pointerSha256);
  assert.deepEqual(await fs.readFile(file), before); assert.equal((await fs.lstat(file)).mtimeMs, beforeStamp.mtimeMs);
});

test("plaintext checkpoint descriptors are explicitly unsupported and do not permit rebootstrap", async t => {
  const f = await fixture(t), current = await f.bootstrap(), pointer = JSON.parse(await f.pointer());
  for (const key of ["compression", "storageSha256", "storageBytes", "rawBytes"]) delete pointer[key];
  await fs.writeFile(f.pointerFile, JSON.stringify(pointer)); const before = await f.pointer();
  await assert.rejects(f.store.load(), { code: "KEYWORD_INCREMENTAL_STATE_POINTER_INVALID" });
  await assert.rejects(f.store.bootstrap(), { code: "KEYWORD_INCREMENTAL_STATE_POINTER_INVALID" }); assert.deepEqual(await f.pointer(), before);
  assert.equal(current.state.generation, 1);
});

test("present state pointer with a missing gzip blob fails closed instead of returning no checkpoint", async t => {
  const f = await fixture(t), current = await f.bootstrap(), file = path.join(f.store.directory, "states", current.stateSha256 + ".json.gz");
  await fs.rename(file, file + ".preserved"); const pointer = await f.pointer();
  await assert.rejects(f.store.load(), { code: "ENOENT" }); await assert.rejects(f.store.bootstrap(), { code: "ENOENT" });
  assert.deepEqual(await f.pointer(), pointer); assert.equal((await fs.readFile(file + ".preserved")).length > 0, true);
});

test("gzip state rejects tamper, truncation, invalid streams, wrong hashes/lengths, schema and expansion overflow", async t => {
  const variants = ["tamper", "truncation", "invalidGzip", "truncatedGzip", "rawHash", "rawLength", "storageLength", "storageHash", "schema", "expansion"];
  for (const variant of variants) await t.test(variant, async st => {
    const f = await fixture(st), current = await f.bootstrap(), pointer = JSON.parse(await f.pointer()), original = path.join(f.store.directory, "states", current.stateSha256 + ".json.gz");
    let file = original, stored = await fs.readFile(file), expectedCode;
    if (variant === "tamper") { stored = Buffer.from(stored); stored[stored.length - 1] ^= 1; expectedCode = "KEYWORD_INCREMENTAL_STATE_STORAGE_MISMATCH"; }
    if (variant === "truncation") { stored = stored.subarray(0, stored.length - 5); expectedCode = "KEYWORD_INCREMENTAL_STATE_STORAGE_MISMATCH"; }
    if (variant === "invalidGzip") { stored = Buffer.from("invalid gzip bytes"); pointer.storageSha256 = sha(stored); pointer.storageBytes = stored.length; expectedCode = "KEYWORD_INCREMENTAL_STATE_DECOMPRESSION_INVALID"; }
    if (variant === "truncatedGzip") { stored = stored.subarray(0, stored.length - 5); pointer.storageSha256 = sha(stored); pointer.storageBytes = stored.length; expectedCode = "KEYWORD_INCREMENTAL_STATE_DECOMPRESSION_INVALID"; }
    if (variant === "rawHash") { pointer.stateSha256 = "f".repeat(64); file = path.join(f.store.directory, "states", pointer.stateSha256 + ".json.gz"); expectedCode = "KEYWORD_INCREMENTAL_STATE_RAW_MISMATCH"; }
    if (variant === "rawLength") { pointer.rawBytes++; expectedCode = "KEYWORD_INCREMENTAL_STATE_RAW_MISMATCH"; }
    if (variant === "storageLength") { pointer.storageBytes++; expectedCode = "KEYWORD_INCREMENTAL_STATE_STORAGE_MISMATCH"; }
    if (variant === "storageHash") { pointer.storageSha256 = "f".repeat(64); expectedCode = "KEYWORD_INCREMENTAL_STATE_STORAGE_MISMATCH"; }
    if (variant === "schema") {
      const raw = Buffer.from("{}"); stored = zlib.gzipSync(raw); pointer.stateSha256 = sha(raw); pointer.rawBytes = raw.length; pointer.storageSha256 = sha(stored); pointer.storageBytes = stored.length;
      file = path.join(f.store.directory, "states", pointer.stateSha256 + ".json.gz"); expectedCode = "KEYWORD_INCREMENTAL_STATE_INVALID";
    }
    if (variant === "expansion") {
      stored = zlib.gzipSync(Buffer.alloc(MAX_STATE + 1, 32)); pointer.storageSha256 = sha(stored); pointer.storageBytes = stored.length; pointer.rawBytes = MAX_STATE;
      expectedCode = "KEYWORD_INCREMENTAL_STATE_DECOMPRESSION_INVALID";
    }
    await fs.writeFile(file, stored); await fs.writeFile(f.pointerFile, JSON.stringify(pointer)); const before = await f.pointer();
    await assert.rejects(f.store.load(), { code: expectedCode }); assert.deepEqual(await f.pointer(), before); assert.deepEqual(await fs.readFile(file), stored);
  });
});

test("bootstrap tees exact BOM/CRLF/Unicode/unterminated bytes once while preserving company order and physical ordinals", async t => {
  const f = await fixture(t), master = { companies: { b: company("b", { originalNote: "가😀".repeat(20000) }), a: company("a") } };
  const masterRaw = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(JSON.stringify(master, null, 2).replace(/\n/g, "\r\n") + "\r\n")]);
  const historyRaw = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(JSON.stringify(row(1)) + "\r\n\r\nmalformed\r" + JSON.stringify(row(2)))]);
  await fs.writeFile(f.masterFile, masterRaw); await fs.writeFile(f.historyFile, historyRaw); const streams = { company: 0, history: 0 };
  patch(t, native, "createReadStream", original => (file, ...args) => { if (file === f.masterFile) streams.company++; if (file === f.historyFile) streams.history++; return original(file, ...args); });
  const result = await f.bootstrap(); assert.deepEqual(streams, { company: 1, history: 1 });
  assert.equal(result.state.bootstrapSources.company.sha256, sha(masterRaw)); assert.equal(result.state.bootstrapSources.company.bytes, masterRaw.length);
  assert.equal(result.state.bootstrapSources.history.sha256, sha(historyRaw)); assert.equal(result.state.bootstrapSources.history.bytes, historyRaw.length);
  assert.equal(result.state.bootstrapSources.history.sourceStamp.size, String(historyRaw.length)); assert.equal(f.store.counters.originalHistoryBytes, historyRaw.length);
  assert.deepEqual(result.state.companies.map(e => e.companyId), ["b", "a"]); assert.equal((await f.store.readCompany("b", result.state.companies[0])).originalNote, master.companies.b.originalNote);
  assert.deepEqual((await rowsOf(f.store, result.state)).map(e => e.ordinal), [1, 4]); assert.equal(result.state.history.malformedHistoryLines, 1);
});

test("a logically equivalent shortened stream cannot certify the original raw file hash or size", async t => {
  const f = await fixture(t), bytes = (await fs.lstat(f.historyFile)).size;
  patch(t, native, "createReadStream", original => (file, options) => original(file, file === f.historyFile ? { ...options, end: bytes - 2 } : options));
  await assert.rejects(f.bootstrap(), { code: "KEYWORD_INCREMENTAL_BOOTSTRAP_SOURCE_CHANGED" });
  assert.equal(await f.store.load(), null); await assert.rejects(fs.lstat(f.pointerFile), { code: "ENOENT" });
});

test("bootstrap rejects each over-2GiB source stamp before opening either original body", async t => {
  for (const name of ["masterFile", "historyFile"]) await t.test(name, async st => {
    const f = await fixture(st); let opened = 0;
    patch(st, fs, "lstat", original => async (file, options) => {
      const stat = await original(file, options); return file === f[name] && options?.bigint ? new Proxy(stat, { get(target, key) { return key === "size" ? BigInt(BOOTSTRAP_LIMITS.sourceBytes) + 1n : Reflect.get(target, key, target); } }) : stat;
    });
    patch(st, native, "createReadStream", original => (...args) => { opened++; return original(...args); });
    await assert.rejects(f.bootstrap(), { code: "KEYWORD_INCREMENTAL_BOOTSTRAP_SOURCE_BOUND" }); assert.equal(opened, 0); assert.equal(await f.store.load(), null);
  });
});

test("bootstrap physical free-space reserve is checked initially and again before subsequent private company writes", async t => {
  for (const initiallyLow of [true, false]) await t.test(initiallyLow ? "initial" : "after-first-blob", async st => {
    const f = await fixture(st); let calls = 0;
    patch(st, fs, "statfs", original => async (file, options) => {
      const disk = await original(file, options); if (file !== f.dataDir) return disk;
      calls++; const low = initiallyLow || (await fs.readdir(f.store.blobDir)).length > 0;
      return { ...disk, bsize: 4096n, bavail: low ? 0n : BigInt(BOOTSTRAP_LIMITS.reserveBytes) / 4096n + 100000n };
    });
    await assert.rejects(f.bootstrap(), { code: "KEYWORD_INCREMENTAL_BOOTSTRAP_DISK_RESERVE" }); assert.equal(await f.store.load(), null);
    assert.ok(calls > 0); if (!initiallyLow) assert.ok((await fs.readdir(f.store.blobDir)).length > 0, "Previously completed private work must remain preserved");
  });
});

test("bootstrap enforces its fifteen-minute bound without treating a timed-out partial read as a checkpoint", async t => {
  const f = await fixture(t), originalNow = Date.now, began = originalNow(); let elapsed = 0;
  Date.now = () => began + elapsed; t.after(() => { Date.now = originalNow; });
  await assert.rejects(f.store.bootstrap({ projectCompany: raw => { elapsed = BOOTSTRAP_LIMITS.milliseconds + 1; return project(raw); } }), { code: "KEYWORD_INCREMENTAL_BOOTSTRAP_TIME_BOUND" });
  assert.equal(await f.store.load(), null); assert.ok((await fs.readdir(f.store.blobDir)).length > 0);
});

test("mock source stamps above 512MiB do not impose bootstrap body reads on normal delta adoption", async t => {
  const f = await fixture(t), first = await f.bootstrap(), largeOffset = 512n * 1024n * 1024n;
  patch(t, fs, "lstat", original => async (file, options) => {
    const stat = await original(file, options); return file === f.historyFile && options?.bigint ? new Proxy(stat, { get(target, key) { return key === "size" ? target.size + largeOffset : Reflect.get(target, key, target); } }) : stat;
  });
  const baseline = clone(first.state); baseline.sourceStamps.history = sourceStamp(await fs.lstat(f.historyFile, { bigint: true }));
  const current = await f.store.save(baseline, first.pointerSha256), fresh = await f.historyEvent([row(3)]), store = f.make();
  patch(t, native, "createReadStream", original => (file, ...args) => { assert.ok(file !== f.masterFile && file !== f.historyFile, "Delta reopened an original body"); return original(file, ...args); });
  patch(t, fs, "readFile", original => (file, ...args) => { assert.ok(file !== f.masterFile && file !== f.historyFile, "Delta reread an original body"); return original(file, ...args); });
  const adopted = await store.apply({ current, events: [fresh], projectCompany: project });
  assert.ok(BigInt(adopted.state.sourceStamps.history.size) > largeOffset); assert.equal(adopted.state.history.rows, 3);
  assert.equal(store.counters.originalMasterBodyReads, 0); assert.equal(store.counters.originalHistoryBodyReads, 0);
  assert.deepEqual(adopted.state.bootstrapSources, first.state.bootstrapSources);
});

test("historical checkpoint reads are independent of current pointer/source state and never open originals", async t => {
  const f = await fixture(t), first = await f.bootstrap(), fresh = await f.historyEvent([row(3)]);
  const latest = await f.store.apply({ current: first, events: [fresh], projectCompany: project }); assert.notEqual(latest.stateSha256, first.stateSha256);
  await fs.writeFile(f.pointerFile, "malformed-current-pointer"); const pointer = await f.pointer();
  patch(t, native, "createReadStream", original => (file, ...args) => { assert.ok(file !== f.masterFile && file !== f.historyFile); return original(file, ...args); });
  patch(t, fs, "readFile", original => (file, ...args) => { assert.ok(file !== f.masterFile && file !== f.historyFile); return original(file, ...args); });
  const resumed = f.make(), saved = await resumed.readCheckpoint(first.stateSha256);
  assert.deepEqual(saved.state, first.state); assert.equal(saved.state.history.rows, 2); assert.equal(saved.stateSha256, first.stateSha256);
  const bytes = await fs.readFile(path.join(f.store.directory, "states", first.stateSha256 + ".json.gz"));
  assert.equal(saved.storageSha256, sha(bytes)); assert.equal(saved.storageBytes, bytes.length); assert.equal(saved.rawBytes, zlib.gunzipSync(bytes).length);
  assert.deepEqual(await f.pointer(), pointer); assert.equal(resumed.counters.originalMasterBodyReads, 0); assert.equal(resumed.counters.originalHistoryBodyReads, 0);
});

test("historical checkpoint recovery rejects unsafe IDs, corrupt gzip/raw SHA and invalid bootstrap metadata", async t => {
  const f = await fixture(t), current = await f.bootstrap(), pointer = await f.pointer();
  await assert.rejects(f.store.readCheckpoint("../source-current"), { code: "KEYWORD_INCREMENTAL_STATE_ID_INVALID" });
  await assert.rejects(f.store.readCheckpoint("f".repeat(64)), { code: "ENOENT" });
  const original = path.join(f.store.directory, "states", current.stateSha256 + ".json.gz"), stored = await fs.readFile(original);
  await fs.writeFile(original, stored.subarray(0, stored.length - 3));
  await assert.rejects(f.store.readCheckpoint(current.stateSha256), { code: "KEYWORD_INCREMENTAL_STATE_DECOMPRESSION_INVALID" });
  const mismatched = "e".repeat(64); await fs.writeFile(path.join(f.store.directory, "states", mismatched + ".json.gz"), stored);
  await assert.rejects(f.store.readCheckpoint(mismatched), { code: "KEYWORD_INCREMENTAL_STATE_RAW_MISMATCH" });
  const invalid = clone(current.state); invalid.bootstrapSources.company.bytes++;
  const raw = Buffer.from(JSON.stringify(invalid)), invalidId = sha(raw); await fs.writeFile(path.join(f.store.directory, "states", invalidId + ".json.gz"), zlib.gzipSync(raw));
  await assert.rejects(f.store.readCheckpoint(invalidId), { code: "KEYWORD_INCREMENTAL_BOOTSTRAP_SOURCE_INVALID" }); assert.deepEqual(await f.pointer(), pointer);
});

test("persistent inventory runs once per store and immutable company reuse is not reserved twice", async t => {
  const f = await fixture(t); await f.store.initialize(); let scans = 0;
  patch(t, fs, "opendir", original => async (...args) => { scans++; return original(...args); });
  await f.store.initialize(); const one = await f.store.putCompany(f.master.companies.a), charged = f.store.counters.persistentReservedBytes;
  assert.equal(charged, one.bytes); assert.equal(f.store.counters.newReservations, 1);
  await f.store.putCompany(f.master.companies.a); assert.equal(f.store.counters.persistentReservedBytes, charged); assert.equal(f.store.counters.newReservations, 1);
  await f.store.putCompany(f.master.companies.b); assert.equal(f.store.counters.newReservations, 2); assert.equal(scans, 0); assert.equal(f.store.counters.storageInventoryPasses, 1);
});

test("sparse old failed-job bytes above 960MiB block allocation using metadata only", async t => {
  const f = await fixture(t), orphanDir = path.join(f.store.directory, "jobs", "failed-owned-job"); await fs.mkdir(orphanDir, { recursive: true });
  const file = path.join(orphanDir, "preparation-preserved.bin"), handle = await fs.open(file, "wx"); try { await handle.truncate(961 * 1024 * 1024); } finally { await handle.close(); }
  patch(t, fs, "readFile", original => (target, ...args) => { assert.notEqual(target, file, "Inventory must not read the sparse body"); return original(target, ...args); });
  await assert.rejects(f.store.putCompany(f.master.companies.a), { code: "KEYWORD_INCREMENTAL_PERSISTENT_BOUND" });
  assert.equal((await fs.lstat(file)).size, 961 * 1024 * 1024); assert.deepEqual(await fs.readdir(f.store.blobDir), []); assert.equal(f.store.counters.newReservations, 0);
});

test("old orphan preparation files count against the initial budget even when no current pointer references them", async t => {
  const f = await fixture(t), orphanDir = path.join(f.store.directory, "jobs", "interrupted-job", "unpromoted"); await fs.mkdir(orphanDir, { recursive: true });
  const file = path.join(orphanDir, "unknown-but-preserved.bin"), size = PERSISTENT_LIMITS.bytes - 5, handle = await fs.open(file, "wx"); try { await handle.truncate(size); } finally { await handle.close(); }
  await f.store.initialize(); assert.equal(f.store.counters.persistentReservedBytes, size);
  await assert.rejects(f.store.putCompany(f.master.companies.a), { code: "KEYWORD_INCREMENTAL_PERSISTENT_BOUND" });
  assert.deepEqual(await fs.readdir(f.store.blobDir), []); assert.equal((await fs.lstat(file)).size, size);
});

test("new persistent blobs require 512MiB plus their actual compressed size in physical free space", async t => {
  const f = await fixture(t); await f.store.initialize(); const expectedBytes = zlib.gzipSync(Buffer.from(JSON.stringify(f.master.companies.a))).length; let enough = false;
  patch(t, fs, "statfs", original => async (file, options) => { const stat = await original(file, options); return file === f.dataDir ? { ...stat, bsize: 1n,
    bavail: BigInt(PERSISTENT_LIMITS.reserveBytes + expectedBytes - (enough ? 0 : 1)) } : stat; });
  await assert.rejects(f.store.putCompany(f.master.companies.a), { code: "KEYWORD_INCREMENTAL_PERSISTENT_DISK_RESERVE" });
  assert.equal(f.store.counters.newReservations, 0); assert.deepEqual(await fs.readdir(f.store.blobDir), []);
  enough = true; const written = await f.store.putCompany(f.master.companies.a); assert.equal(written.bytes, expectedBytes); assert.equal(f.store.counters.persistentReservedBytes, expectedBytes);
});

test("unknown write failures keep their full reservation and cannot refund budget for later blobs", async t => {
  const f = await fixture(t); await f.store.initialize(); const failedBytes = zlib.gzipSync(Buffer.from(JSON.stringify(f.master.companies.a))).length; let fail = true;
  patch(t, fs, "open", original => async (file, flags, ...args) => {
    if (fail && path.dirname(file) === f.store.blobDir && flags === "wx") { fail = false; throw Object.assign(Error("write outcome unknown"), { code: "EIO" }); }
    return original(file, flags, ...args);
  });
  await assert.rejects(f.store.putCompany(f.master.companies.a), { code: "EIO" }); assert.equal(f.store.counters.persistentReservedBytes, failedBytes);
  const next = await f.store.putCompany(f.master.companies.b); assert.equal(f.store.counters.persistentReservedBytes, failedBytes + next.bytes); assert.equal(f.store.counters.newReservations, 2);
});

test("persistent inventory rejects links and excessive nesting without following outside paths", async t => {
  for (const kind of ["symlink", "hardlink", "depth"]) await t.test(kind, async st => {
    const f = await fixture(st); await fs.mkdir(f.store.directory); const outside = path.join(f.dataDir, "original-preserved.json"); await fs.writeFile(outside, "original");
    if (kind === "symlink") await fs.symlink(path.dirname(outside), path.join(f.store.directory, "outside"), process.platform === "win32" ? "junction" : "dir");
    if (kind === "hardlink") await fs.link(outside, path.join(f.store.directory, "linked.json"));
    if (kind === "depth") { let dir = f.store.directory; for (let i = 0; i <= PERSISTENT_LIMITS.depth; i++) { dir = path.join(dir, "d"); await fs.mkdir(dir); } }
    await assert.rejects(f.store.initialize(), error => /(?:PERSISTENT_PATH_UNSAFE|PERSISTENT_INVENTORY_BOUND|PATH_UNSAFE)$/.test(error.code));
    assert.equal(await fs.readFile(outside, "utf8"), "original");
  });
});
