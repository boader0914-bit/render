"use strict";
// Exercise AST-extracted real source writers without loading the app entry point,
// collectors, credentials, schedules or provider factories.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), fsp = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), vm = require("node:vm");
const { sourceStamp } = require("./lib/keyword_monthly_incremental_state.cjs");
const { createKeywordMonthlySourceDelta } = require("./lib/keyword_monthly_source_delta.cjs");
const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
const parser = { exports: {} }; new Function("exports", "module", process.binding("natives")["internal/deps/acorn/acorn/dist/acorn"])(parser.exports, parser);
const ast = parser.exports.parse(source, { ecmaVersion: "latest", sourceType: "script" });
const declaration = name => { const node = ast.body.find(item => item.type === "FunctionDeclaration" && item.id.name === name); assert.ok(node, name); return source.slice(node.start, node.end); };
const helpers = ["keywordMonthlyDeltaReason", "readKeywordMonthlySourceStamp"].map(declaration).join("\n");
const plain = value => JSON.parse(JSON.stringify(value));
async function fixture(t) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "keyword-delta-app-hook-"));
  t.after(async () => { assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fsp.rm(dataDir, { recursive: true, force: true }); });
  await fsp.mkdir(path.join(dataDir, "company_master")); await fsp.mkdir(path.join(dataDir, "history"));
  const outbox = createKeywordMonthlySourceDelta({ dataDir });
  const logs = [], events = [], context = { Map, Date, Object, Array, JSON, Error, Set, crypto, path, process: { pid: process.pid },
    fsp, fs: { existsSync: () => true }, keywordMonthlySourceStamp: sourceStamp, console: { error: (...args) => logs.push(args) },
    COMPANY_MASTER_DIR: path.join(dataDir, "company_master"), COMPANY_MASTER_FILE: path.join(dataDir, "company_master", "companies.json"),
    HISTORY_OBSERVATIONS_FILE: path.join(dataDir, "history", "observations.jsonl"),
    // VM literals belong to another realm; the production app and module share
    // one realm. Cross this test-only boundary with the same lossless JSON input.
    keywordMonthlySourceDelta: { ...outbox, recordCompanyDelta: input => outbox.recordCompanyDelta(plain(input)) },
    companyBootstrapStore: { invalidate: () => events.push(["bootstrap"]) },
    invalidateIndustryAnalysis: async reason => events.push(["industry", reason]),
    queueIntegratedCompanies: async (ids, reason) => events.push(["queue", plain(ids), reason]) };
  vm.createContext(context); vm.runInContext(helpers + "\n" + ["stableJson", "readStoredCompanyIntegrationSignatures", "writeCompanyMaster"].map(declaration).join("\n"), context);
  return { dataDir, logs, events, context, save: value => fsp.writeFile(context.COMPANY_MASTER_FILE, JSON.stringify(value)),
    read: async () => JSON.parse(await fsp.readFile(context.COMPANY_MASTER_FILE, "utf8")) };
}
async function companyEvent(f) {
  const listed = await f.context.keywordMonthlySourceDelta.listEvents(); assert.equal(listed.status, "available");
  assert.equal(listed.events.length, 1); return (await f.context.keywordMonthlySourceDelta.readEvent(listed.events[0].eventId)).event;
}

test("AST wiring instantiates an inert private outbox and leaves original write operations intact", () => {
  const imports = ast.body.filter(node => node.type === "VariableDeclaration").flatMap(node => node.declarations);
  const outbox = imports.find(node => node.id.type === "Identifier" && node.id.name === "keywordMonthlySourceDelta");
  assert.equal(outbox.init.callee.name, "createKeywordMonthlySourceDelta"); assert.equal(outbox.init.arguments[0].properties[0].value.name, "DATA_DIR");
  const writer = declaration("writeCompanyMaster"), history = declaration("appendHistoryForRunUnlocked");
  assert.ok(writer.indexOf("await fsp.rename(tempPath, COMPANY_MASTER_FILE)") < writer.indexOf("recordCompanyDelta"));
  assert.ok(history.indexOf("await historyObservationIndex.append(") < history.indexOf("recordHistoryDelta"));
  assert.equal((declaration("readStoredCompanyIntegrationSignatures").match(/fsp\.readFile\(/g) || []).length, 1);
  assert.equal((writer.match(/fsp\.readFile\(/g) || []).length, 0);
  assert.doesNotMatch(writer + history, /(?:unlink|rm|fetch|spawn|restart|resetProtection)\s*\(/);
});

test("one existing full read yields unchanged active signatures plus non-enumerable complete raw signatures", async t => {
  const f = await fixture(t), initial = { companies: { z: { rank: 2, companyId: "z" }, merged: { companyId: "merged", mergedIntoCompanyId: "z" }, deleted: { companyId: "deleted", deletedAt: "old" } } };
  await f.save(initial); let reads = 0; f.context.fsp = { ...fsp, readFile: async (file, ...args) => { if (file === f.context.COMPANY_MASTER_FILE) reads++; return fsp.readFile(file, ...args); } };
  const signatures = await f.context.readStoredCompanyIntegrationSignatures();
  assert.deepEqual([...signatures.keys()], ["z"]); assert.equal(reads, 1); assert.equal(Object.keys(signatures).includes("monthlySource"), false);
  assert.deepEqual(signatures.monthlySource.order, ["z", "merged", "deleted"]); assert.equal(signatures.monthlySource.allSignatures.size, 3);
  assert.equal(signatures.monthlySource.allSignatures.get("z"), crypto.createHash("sha256").update(JSON.stringify(initial.companies.z)).digest("hex"));
  assert.deepEqual(signatures.monthlySource.sourceStampBefore, sourceStamp(await fsp.lstat(f.context.COMPANY_MASTER_FILE, { bigint: true })));
});

test("post-rename delta retains raw key/order changes, deleted and merged records, removed tombstones", async t => {
  const f = await fixture(t), initial = { companies: { a: { companyId: "a", first: 1, last: 2 }, gone: { companyId: "gone" }, merged: { companyId: "merged" } } };
  await f.save(initial); const before = sourceStamp(await fsp.lstat(f.context.COMPANY_MASTER_FILE, { bigint: true }));
  const next = { companies: { merged: { companyId: "merged", mergedIntoCompanyId: "a" }, a: { last: 2, first: 1, companyId: "a", omitted: undefined }, deleted: { companyId: "deleted", deletedAt: "today" } } };
  await f.context.writeCompanyMaster(next); const event = await companyEvent(f), payload = event.payload;
  assert.equal(event.kind, "companies"); assert.deepEqual(payload.order, ["merged", "a", "deleted"]);
  assert.deepEqual(payload.changes.map(row => row.companyId), ["merged", "a", "deleted", "gone"]);
  assert.equal(payload.changes.at(-1).company, null); assert.equal(payload.changes.at(-1).orderIndex, 1);
  assert.deepEqual(Object.keys(payload.changes[1].company), ["last", "first", "companyId"]);
  assert.equal(payload.changes[0].company.mergedIntoCompanyId, "a"); assert.equal(payload.changes[2].company.deletedAt, "today");
  assert.deepEqual(payload.sourceStamp.before, before); assert.deepEqual(payload.sourceStamp.after, sourceStamp(await fsp.lstat(f.context.COMPANY_MASTER_FILE, { bigint: true })));
  // The existing stableJson signature also sees the in-memory undefined field;
  // preserve its original active-company admission independently of raw JSON.
  assert.deepEqual(f.events, [["bootstrap"], ["industry", "company_saved"], ["queue", ["a"], "company_saved"]]);
  assert.deepEqual((await f.read()).companies, plain(next.companies)); assert.deepEqual(f.logs, []);
});

test("first creation and order-only save publish source transitions without changing active-company admission", async t => {
  const f = await fixture(t); await f.context.writeCompanyMaster({ companies: { a: { companyId: "a" }, b: { companyId: "b" } } });
  const first = await companyEvent(f); assert.equal(first.payload.sourceStamp.before, null); assert.deepEqual(f.events.at(-1), ["queue", ["a", "b"], "company_saved"]);
  await f.context.writeCompanyMaster({ companies: { b: { companyId: "b" }, a: { companyId: "a" } } });
  const listed = await f.context.keywordMonthlySourceDelta.listEvents(); assert.equal(listed.events.length, 2);
  const loaded = await Promise.all(listed.events.map(row => f.context.keywordMonthlySourceDelta.readEvent(row.eventId))), reordered = loaded.map(row => row.event).find(row => row.payload.sourceStamp.before !== null);
  assert.deepEqual(reordered.payload.changes, []); assert.deepEqual(reordered.payload.order, ["b", "a"]); assert.deepEqual(f.events.at(-1), ["queue", [], "company_saved"]);
});

test("source change during existing read holds only monthly delta and preserves original writer results", async t => {
  const f = await fixture(t); await f.save({ companies: { a: { companyId: "a" } } }); let changed = false;
  f.context.fsp = { ...fsp, readFile: async (file, ...args) => {
    const bytes = await fsp.readFile(file, ...args); if (!changed && file === f.context.COMPANY_MASTER_FILE) { changed = true; await fsp.writeFile(file, bytes + " "); } return bytes;
  } };
  await f.context.writeCompanyMaster({ companies: { a: { companyId: "a", value: 2 } } });
  assert.equal((await f.read()).companies.a.value, 2); assert.deepEqual(f.events.at(-1), ["queue", ["a"], "company_saved"]);
  assert.deepEqual(f.logs, [["keyword_monthly_source_delta_needs_verification", "KEYWORD_DELTA_SOURCE_CHANGED"]]);
  await assert.rejects(fsp.lstat(path.join(f.dataDir, "keyword_monthly_source_delta")), { code: "ENOENT" });
});

test("company outbox refusal or thrown private error cannot change source success or leak text", async t => {
  for (const throws of [false, true]) await t.test(String(throws), async st => {
    const f = await fixture(st); await f.save({ companies: { a: { companyId: "a" } } });
    f.context.keywordMonthlySourceDelta = { recordCompanyDelta: async () => { if (throws) throw Error("private account token"); return { status: "needs_verification", errorCode: "ENOSPC" }; } };
    await f.context.writeCompanyMaster({ companies: { a: { companyId: "a", value: 3 } } });
    assert.equal((await f.read()).companies.a.value, 3); assert.deepEqual(f.events.at(-1), ["queue", ["a"], "company_saved"]);
    assert.equal(f.logs.length, 1); assert.equal(f.logs[0].length, 2); assert.equal(JSON.stringify(f.logs).includes("private account token"), false);
  });
});

async function historyFixture(t, { indexed = true, appendError = null, deltaError = null } = {}) {
  const f = await fixture(t), observations = [{ observationId: 1, companyId: "a", runId: "run_1", stayDate: "2026-11-20", sold: 0, optional: undefined },
    { observationId: "1", companyId: "a", runId: "run_1", stayDate: "2026-11-20", sold: 3 }], known = new Set(), deltas = [], calls = [];
  await fsp.writeFile(f.context.HISTORY_OBSERVATIONS_FILE, "");
  Object.assign(f.context, { sharedWrite: operation => operation(), runAnalyticalWork: operation => operation(), companyIntegratedDb: { deferProcessing: operation => operation() },
    resolveRunDir: () => "unused-local-fixture", readManifest: async () => ({}), allowsDerivedUpdates: () => true,
    loadRun: async () => ({ run: { collectedAt: "2026-11-15T01:00:00Z" }, companyMaster: { activeCompanyIds: ["a"] } }),
    runCollectionDbRoute: () => ({ appliesHistory: true }), buildHistoryObservations: () => observations,
    masterDbDualWriteQueue: { mode: "off" }, historyObservationIndex: {
      findObservationIds: async () => ({ existingIds: new Set(known), needsSeparator: false }),
      append: async body => { calls.push("append"); await fsp.appendFile(f.context.HISTORY_OBSERVATIONS_FILE, body); if (appendError) throw appendError;
        for (const row of observations) known.add(row.observationId); return { indexed }; }
    }, keywordMonthlySourceDelta: { recordHistoryDelta: async input => {
      calls.push("delta"); assert.equal((await fsp.readFile(f.context.HISTORY_OBSERVATIONS_FILE, "utf8")).trim().split("\n").length, observations.length);
      deltas.push(plain(input)); if (deltaError) throw deltaError; return { status: "complete" };
    } } });
  vm.runInContext(["appendHistoryForRun", "appendHistoryForRunUnlocked"].map(declaration).join("\n"), f.context);
  return { ...f, observations, deltas, calls, append: () => f.context.appendHistoryForRun("run_1", { skipExternal: true }) };
}

test("history outbox receives precisely durable missing rows, typed IDs, source stamps and index status", async t => {
  const f = await historyFixture(t, { indexed: false }), before = sourceStamp(await fsp.lstat(f.context.HISTORY_OBSERVATIONS_FILE, { bigint: true }));
  const result = await f.append(); assert.equal(result.appended, 2); assert.equal(result.observationIndex.updated, false); assert.deepEqual(f.calls, ["append", "delta"]);
  assert.deepEqual(f.deltas[0].rows, plain(f.observations)); assert.equal(f.deltas[0].runId, "run_1"); assert.equal(f.deltas[0].indexUpdated, false);
  assert.deepEqual(f.deltas[0].sourceStamp.before, before); assert.deepEqual(f.deltas[0].sourceStamp.after, sourceStamp(await fsp.lstat(f.context.HISTORY_OBSERVATIONS_FILE, { bigint: true })));
  assert.equal((await f.append()).appended, 0); assert.equal(f.deltas.length, 1);
});

test("history delta error is independent while original uncertain append still throws unchanged", async t => {
  const f = await historyFixture(t, { deltaError: Error("private provider detail") });
  assert.equal((await f.append()).appended, 2); assert.equal(f.logs.length, 1); assert.equal(JSON.stringify(f.logs).includes("private provider detail"), false);
  const uncertain = Object.assign(Error("uncertain original append"), { code: "HISTORY_OBSERVATION_SOURCE_APPEND_UNCERTAIN" }), failed = await historyFixture(t, { appendError: uncertain });
  await assert.rejects(failed.append(), error => error === uncertain); assert.deepEqual(failed.calls, ["append"]); assert.equal(failed.deltas.length, 0);
});
