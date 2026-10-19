"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createCompanyIntegratedSourceRevision, VERSION } = require("./lib/company_integrated_source_revision.cjs");
const A = "cmp_place_100", B = "cmp_place_200";
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "company-revision-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("company-revision-")); await fs.rm(root, { recursive: true, force: true }); });
  const write = async (name, value) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value)); };
  const units = [100, 200].map(value => ({ regionKey: "region_" + value, regionId: "KR" + value, active: true, selectable: true, level: "local", name: "지역" + value, fullName: "시험도 지역" + value, aliases: ["지역" + value] }));
  const master = { companies: Object.fromEntries([100, 200].map(value => ["cmp_place_" + value, { companyId: "cmp_place_" + value, primaryName: "모의 글램핑" + value, placeIds: [String(value)],
    addresses: ["시험도 지역" + value + " 주소"], keywords: { initial: { keyword: "모의글램핑", runs: [{ runId: "run_" + value, collectedAt: "2026-09-01T00:00:00Z", rank: 1 }] } }, manualCorrection: { capacity: 16 } }])) };
  const rows = [{ companyId: A, runId: "run_100", stayDate: "2026-08-31", value: 0, status: "observed" }, { companyId: A, runId: "run_100", stayDate: "2026-09-01", value: 1, status: "observed" },
    { companyId: B, runId: "run_200", stayDate: "2026-09-01", value: 2, status: "observed" }];
  const history = () => write("history/observations.jsonl", rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  await write("regions.json", { units }); await write("tourism-map.json", { version: "fixture" }); await write("company_master/companies.json", master); await history();
  await write("company_integrated/capacity-bases.json", { schemaVersion: 1, companies: { [A]: { count: 16 }, [B]: { count: 16 } } });
  for (const value of [100, 200]) await write("outputs/run_" + value + "/manifest.json", { id: "run_" + value, status: "complete" });
  const options = { dataDir: root, regionMasterFile: path.join(root, "regions.json"), tourismRegionMapFile: path.join(root, "tourism-map.json"), includeContext: true };
  return { root, write, master, rows, history, options };
}
const scope = (companyId, month) => ({ companyId, month, cutoffDate: month + "-28", calculationVersion: "fixture-v1" });

test("durable metadata index reuses unchanged inputs after restart and isolates company/month observation, rank, correction and saved-run changes", async t => {
  const f = await fixture(t); let streams = 0, masterReads = 0;
  const fileSystem = Object.create(fs); fileSystem.readFile = async (file, ...args) => { if (String(file).endsWith("company_master" + path.sep + "companies.json")) masterReads++; return fs.readFile(file, ...args); };
  const options = { ...f.options, fileSystem, historyStream: file => { streams++; return native.createReadStream(file, { encoding: "utf8" }); } };
  let reader = createCompanyIntegratedSourceRevision(options), prepared = await reader.prepare();
  const token = (company, month) => reader.forScope(prepared, scope(company, month));
  const initial = { a8: token(A, "2026-08"), a9: token(A, "2026-09"), a10: token(A, "2026-10"), b9: token(B, "2026-09") };
  const inputs = await fs.readFile(path.join(f.root, "history/observations.jsonl"), "utf8"), indexFile = path.join(f.root, "company_integrated/revision-index.json"), indexBefore = await fs.readFile(indexFile);
  assert.equal(streams, 1); assert.equal(masterReads, 1);
  reader = createCompanyIntegratedSourceRevision(options); prepared = await reader.prepare();
  assert.equal(streams, 1); assert.equal(masterReads, 1, "Restart must read only metadata and the small durable index");
  assert.deepEqual(await fs.readFile(indexFile), indexBefore); assert.equal(token(A, "2026-09"), initial.a9);
  f.rows[1].value = 0; f.rows[1].status = "error"; await f.history(); prepared = await reader.prepare();
  assert.equal(token(A, "2026-08"), initial.a8); assert.notEqual(token(A, "2026-09"), initial.a9); assert.notEqual(token(A, "2026-10"), initial.a10, "Previous month is an actual comparison dependency"); assert.equal(token(B, "2026-09"), initial.b9);
  const afterHistory = { a8: token(A, "2026-08"), a9: token(A, "2026-09"), b9: token(B, "2026-09") };
  f.master.companies[A].inventory = { latest: { runId: "run_100", collectedAt: "2026-10-01T00:00:00Z", productSnapshot: { daily: [{ stayDate: "2026-10-02", sold: 0, missing: true }] } } };
  f.master.companies[A].keywords.initial.runs.push({ runId: "run_100", collectedAt: "2026-10-01T00:00:00Z", rank: 2 });
  await f.write("company_master/companies.json", f.master); prepared = await reader.prepare();
  assert.equal(token(A, "2026-08"), afterHistory.a8); assert.equal(token(A, "2026-09"), afterHistory.a9, "Future inventory/rank cannot invalidate closed unrelated months"); assert.equal(token(B, "2026-09"), afterHistory.b9);
  f.master.companies[A].manualCorrection.capacity = 17; await f.write("company_master/companies.json", f.master); prepared = await reader.prepare();
  assert.notEqual(token(A, "2026-08"), afterHistory.a8); assert.equal(token(B, "2026-09"), initial.b9, "A manual room correction is not a global source change");
  const b = token(B, "2026-09"), a = token(A, "2026-09"); await f.write("outputs/run_100/manifest.json", { status: "blocked" }); prepared = await reader.prepare();
  assert.notEqual(token(A, "2026-09"), a); assert.equal(token(B, "2026-09"), b);
  // A recovered original may be known only by company.runIds and have no
  // history/daily/rank rows yet. Its actual query span remains a dependency.
  await f.write("outputs/recovered/manifest.json", { collectedAt: "2026-10-01T00:00:00Z", checkIn: "2026-10-01", bookingRangeDays: 21, status: "complete" });
  f.master.companies[A].runIds = ["recovered"]; await f.write("company_master/companies.json", f.master); prepared = await reader.prepare();
  const recovered = { a9: token(A, "2026-09"), a10: token(A, "2026-10"), b9: token(B, "2026-09") };
  await f.write("outputs/recovered/availability.json", { missing: true, value: 0 }); prepared = await reader.prepare();
  assert.equal(token(A, "2026-09"), recovered.a9); assert.notEqual(token(A, "2026-10"), recovered.a10); assert.equal(token(B, "2026-09"), recovered.b9);
  const changedAlgorithm = createCompanyIntegratedSourceRevision({ ...options, calculationFingerprint: "a".repeat(64) });
  assert.notEqual(changedAlgorithm.forScope(await changedAlgorithm.prepare(), scope(B, "2026-09")), token(B, "2026-09"));
  assert.equal(await fs.readFile(path.join(f.root, "history/observations.jsonl"), "utf8"), f.rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.notEqual(inputs, await fs.readFile(path.join(f.root, "history/observations.jsonl"), "utf8"), "Only the explicit fixture edit changed the source");
});

test("region/month context, annual calendars, global diagnostics and corrupt indexes remain real dependencies without provider requests", async t => {
  const f = await fixture(t), reader = createCompanyIntegratedSourceRevision(f.options); let prepared = await reader.prepare();
  const token = (company, month) => reader.forScope(prepared, scope(company, month));
  const initial = { a8: token(A, "2026-08"), a9: token(A, "2026-09"), a10: token(A, "2026-10"), b9: token(B, "2026-09") };
  await f.write("tourism_data/cache/fixture-202609.json", { region: { regionKey: "region_100" }, yearMonth: "202609", value: 0 }); prepared = await reader.prepare();
  assert.equal(token(A, "2026-08"), initial.a8); assert.notEqual(token(A, "2026-09"), initial.a9); assert.notEqual(token(A, "2026-10"), initial.a10); assert.equal(token(B, "2026-09"), initial.b9);
  const a = token(A, "2026-08"), b = token(B, "2026-09");
  await f.write("history/kosis/" + digest("KR100").slice(0, 24) + "-attempt.json", { outcomes: { population: { status: "error" } } }); prepared = await reader.prepare();
  assert.notEqual(token(A, "2026-08"), a); assert.equal(token(B, "2026-09"), b, "A KOSIS failed latest attempt changes only the linked region");
  const beforeBudget = prepared.revision; await f.write("history/kosis/request-budget.json", { used: 999 }); prepared = await reader.prepare(); assert.equal(prepared.revision, beforeBudget, "Provider usage is not a report input");
  const beforeCalendar = token(B, "2026-09"); await f.write("history/special_days/2026.json", { holidays: [{ date: "2026-09-25" }] }); prepared = await reader.prepare(); assert.notEqual(token(B, "2026-09"), beforeCalendar);
  const beforeMalformed = { a: token(A, "2026-08"), b: token(B, "2026-09") }; await fs.appendFile(path.join(f.root, "history/observations.jsonl"), "malformed\n"); prepared = await reader.prepare();
  assert.notEqual(token(A, "2026-08"), beforeMalformed.a); assert.notEqual(token(B, "2026-09"), beforeMalformed.b, "The report actually carries global malformed-history warnings");
  const C = "cmp_place_300"; f.master.companies[C] = { companyId: C, primaryName: "다른 업체", placeIds: ["300"], addresses: ["시험도 지역200 주소"] };
  f.master.companies[A].placeIds.push("200"); await f.write("company_master/companies.json", f.master); prepared = await reader.prepare();
  const beforeConflict = { c8: token(C, "2026-08"), c9: token(C, "2026-09") };
  f.rows.push({ companyId: A, runId: "run_100", stayDate: "2026-09-03", value: 0, missing: true }); await f.history(); prepared = await reader.prepare();
  // Keep the earlier malformed count unchanged so only the new conflicted row
  // can explain the cross-company monthly diagnostic revision.
  await fs.appendFile(path.join(f.root, "history/observations.jsonl"), "malformed\n"); prepared = await reader.prepare();
  assert.equal(token(C, "2026-08"), beforeConflict.c8); assert.notEqual(token(C, "2026-09"), beforeConflict.c9);
  const beforeFallback = token(C, "2026-09"); f.master.companies[A].inventory = { latest: { productSnapshot: { daily: [{ stayDate: "2026-09-05", value: 0 }] } } };
  await f.write("company_master/companies.json", f.master); prepared = await reader.prepare(); assert.notEqual(token(C, "2026-09"), beforeFallback);
  const stored = JSON.parse(await fs.readFile(path.join(f.root, "company_integrated/revision-index.json"), "utf8"));
  assert.deepEqual(stored.parts.history.runRefs[A]["2026-09"], ["run_100"], "Repeated observation rows store a run reference once");
  const index = path.join(f.root, "company_integrated/revision-index.json"); await fs.writeFile(index, "{broken");
  await assert.rejects(reader.prepare(), { code: "COMPANY_SOURCE_REVISION_INDEX_INVALID" });
  await assert.rejects(createCompanyIntegratedSourceRevision(f.options).prepare(), { code: "COMPANY_SOURCE_REVISION_INDEX_INVALID" });
  // The module has no fetch/provider dependency; the only writes above are the
  // explicit fixture edits and its owned derived revision-index.json.
});

async function contextFixture(f) {
  await f.write("tourism_data/cache/fixture-202609.json", { regionKey: "region_100", yearMonth: "202609", value: 10 });
  await f.write("regional_search_trends/cache/fixture.json", { regionKey: "region_100", month: "2026-09", value: 20 });
  await f.write("tourism_data/cache/unknown.json", { value: null, status: "missing" });
  await f.write("history/special_days/2026.json", { holidays: [{ date: "2026-09-25" }] });
  for (const value of [100, 200]) {
    const key = digest("KR" + value).slice(0, 24);
    await f.write("history/kosis/" + key + ".json", { population: value });
    await f.write("history/kosis/" + key + "-attempt.json", { status: "complete" });
    await f.write("outputs/run_" + value + "/availability.json", { status: "observed", sold: 0 });
  }
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
async function rewriteIndex(file, change) {
  const value = JSON.parse(await fs.readFile(file, "utf8")); change(value); delete value.checksum;
  await fs.writeFile(file, JSON.stringify({ ...value, checksum: digest(JSON.stringify(canonical(value))) }));
}

test("remount identity/timestamps and directory order changes preserve all content-based scope tokens without reparsing company/history", async t => {
  const f = await fixture(t); await contextFixture(f);
  let epoch = 0n, reverse = false, historyReads = 0, masterReads = 0, contentReads = 0;
  const overlay = value => new Proxy(value, { get(target, key) {
    return ["dev", "ino", "mtimeNs", "ctimeNs"].includes(key) ? target[key] + epoch : Reflect.get(target, key);
  } });
  const fileSystem = Object.create(fs);
  fileSystem.lstat = async (...args) => overlay(await fs.lstat(...args));
  fileSystem.readdir = async (...args) => { const values = await fs.readdir(...args); return reverse ? values.reverse() : values; };
  fileSystem.readFile = async (file, ...args) => { if (String(file).endsWith(path.join("company_master", "companies.json"))) masterReads++; return fs.readFile(file, ...args); };
  fileSystem.open = async (file, mode, ...args) => {
    if (mode === "r") contentReads++;
    const handle = await fs.open(file, mode, ...args);
    return new Proxy(handle, { get(target, key) { if (key === "stat") return async (...args) => overlay(await target.stat(...args));
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
  };
  const options = { ...f.options, fileSystem, historyStream: file => { historyReads++; return native.createReadStream(file, { encoding: "utf8" }); } };
  let reader = createCompanyIntegratedSourceRevision(options), prepared = await reader.prepare();
  const before = structuredClone(prepared), index = path.join(f.root, "company_integrated/revision-index.json"), beforeBytes = await fs.readFile(index);
  const count = contentReads; assert.equal(masterReads, 1); assert.equal(historyReads, 1);
  epoch = 987654n; reverse = true;
  reader = createCompanyIntegratedSourceRevision(options); prepared = await reader.prepare();
  assert.deepEqual(prepared, before, "A metadata-only remount must not alter any dependency token, including shared unknown context and calendars");
  assert.equal(masterReads, 1); assert.equal(historyReads, 1, "Byte-equal history is hashed in bounded chunks but is not parsed again");
  assert.ok(contentReads > count, "Changed stat metadata requires verifying actual content once");
  assert.notDeepEqual(await fs.readFile(index), beforeBytes, "Only the derived stat bookkeeping changes");
  const afterBytes = await fs.readFile(index), afterReads = contentReads;
  reader = createCompanyIntegratedSourceRevision(options); assert.deepEqual(await reader.prepare(), before);
  assert.equal(contentReads, afterReads, "The next unchanged restart reuses persisted content hashes without reopening sources");
  assert.deepEqual(await fs.readFile(index), afterBytes);
});

test("byte changes and removals invalidate only linked source scopes, including following-month comparisons", async t => {
  const f = await fixture(t); await contextFixture(f);
  const reader = createCompanyIntegratedSourceRevision(f.options);
  const values = async () => { const prepared = await reader.prepare(); return Object.fromEntries([A, B].flatMap(id => ["2026-08", "2026-09", "2026-10"].map(month => [id + month, reader.forScope(prepared, scope(id, month))]))); };
  let before = await values();
  for (const name of ["tourism_data/cache/fixture-202609.json", "regional_search_trends/cache/fixture.json", "outputs/run_100/availability.json"]) {
    const original = await fs.readFile(path.join(f.root, name), "utf8"), value = JSON.parse(original); value.changed = true; await f.write(name, value);
    const after = await values();
    for (const id of [A, B]) for (const month of ["2026-08", "2026-09", "2026-10"]) {
      assert.equal(after[id + month] !== before[id + month], id === A && (month !== "2026-08" || name.startsWith("outputs/")), name + ": " + id + month);
    }
    before = after;
  }
  await fs.unlink(path.join(f.root, "tourism_data/cache/fixture-202609.json")); let after = await values();
  assert.notEqual(after[A + "2026-09"], before[A + "2026-09"]); assert.equal(after[B + "2026-09"], before[B + "2026-09"]); before = after;
  await f.write("history/kosis/" + digest("KR100").slice(0, 24) + "-attempt.json", { status: "failed" }); after = await values();
  for (const month of ["2026-08", "2026-09", "2026-10"]) { assert.notEqual(after[A + month], before[A + month]); assert.equal(after[B + month], before[B + month]); }
  before = after; await f.write("history/special_days/2026.json", { holidays: [] }); after = await values();
  for (const key of Object.keys(before)) assert.notEqual(after[key], before[key], "A real shared annual calendar edit is a dependency of both companies");
  const stored = JSON.parse(await fs.readFile(path.join(f.root, "company_integrated/revision-index.json"), "utf8"));
  assert.ok(!("tourism/fixture-202609.json" in stored.contentDigests)); assert.ok(!("tourism/fixture-202609.json" in stored.parts.contextFiles));
});

test("checksum-valid legacy indexes migrate once; missing digest entries and corrupt legacy checksums cannot certify reuse", async t => {
  const f = await fixture(t); await contextFixture(f);
  const index = path.join(f.root, "company_integrated/revision-index.json");
  let reader = createCompanyIntegratedSourceRevision(f.options), prepared = await reader.prepare();
  const expected = structuredClone(prepared);
  await rewriteIndex(index, value => {
    value.version = value.prepared.version = "company-integrated-source-revision-v1"; delete value.contentDigests;
    value.prepared.revision = "legacy-stat-only-token"; value.parts.contextFiles["tourism/fixture-202609.json"].digest = "old-metadata";
  });
  reader = createCompanyIntegratedSourceRevision(f.options); prepared = await reader.prepare();
  assert.equal(prepared.version, VERSION); assert.deepEqual(prepared, expected, "Migration rebuilds from actual files rather than trusting legacy prepared tokens");
  const bytes = await fs.readFile(index); assert.deepEqual(await createCompanyIntegratedSourceRevision(f.options).prepare(), expected);
  assert.deepEqual(await fs.readFile(index), bytes, "Migration does not repeat on the next restart");
  await rewriteIndex(index, value => { delete value.contentDigests.history; });
  const invalid = await fs.readFile(index);
  await assert.rejects(createCompanyIntegratedSourceRevision(f.options).prepare(), { code: "COMPANY_SOURCE_REVISION_INDEX_INVALID" });
  assert.deepEqual(await fs.readFile(index), invalid);
  await fs.writeFile(index, bytes); await rewriteIndex(index, value => { value.version = "company-integrated-source-revision-v1"; });
  const corrupt = JSON.parse(await fs.readFile(index)); corrupt.prepared.revision = "tampered"; await fs.writeFile(index, JSON.stringify(corrupt));
  await assert.rejects(createCompanyIntegratedSourceRevision(f.options).prepare(), { code: "COMPANY_SOURCE_REVISION_INDEX_INVALID" });
});

test("a changing or unreadable source during hashing fails closed and preserves the last verified index", async t => {
  const f = await fixture(t); await contextFixture(f);
  const baselineReader = createCompanyIntegratedSourceRevision(f.options); await baselineReader.prepare();
  const index = path.join(f.root, "company_integrated/revision-index.json"), before = await fs.readFile(index);
  await f.write("outputs/run_100/availability.json", { status: "missing", sold: null });
  for (const mode of ["unreadable", "racing"]) {
    const fileSystem = Object.create(fs);
    fileSystem.open = async (file, flags, ...args) => {
      if (flags !== "r" || !String(file).endsWith("availability.json")) return fs.open(file, flags, ...args);
      if (mode === "unreadable") throw Object.assign(new Error("private path must not leak"), { code: "EACCES" });
      const handle = await fs.open(file, flags, ...args); let changed = false;
      return new Proxy(handle, { get(target, key) {
        if (key === "read") return async (...args) => { const result = await target.read(...args); if (!changed) { changed = true; await fs.appendFile(file, " "); } return result; };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    await assert.rejects(createCompanyIntegratedSourceRevision({ ...f.options, fileSystem }).prepare(), { code: "COMPANY_SOURCE_REVISION_UNAVAILABLE", message: "COMPANY_SOURCE_REVISION_UNAVAILABLE" });
    assert.deepEqual(await fs.readFile(index), before, "Failed verification cannot replace the prior derived index");
  }
});
