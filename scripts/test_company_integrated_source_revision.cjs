"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createCompanyIntegratedSourceRevision, VERSION } = require("./lib/company_integrated_source_revision.cjs");
const { createProductCapacityStore } = require("./lib/product_capacity_store.cjs");
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

function recoveryEnvelope(companyId, month, runId, sourceFiles, extra = {}) {
  const core = { kind: "saved_product_recovery_v1", validatorVersion: "fixture-v1", companyId, month, runId,
    collectedAt: "2026-09-01T00:00:00.000Z", originalRunQuality: "unknown", sourceFiles,
    providerIdentity: { placeId: companyId.replace("cmp_place_", "") }, verifiedDates: [], exclusions: [], ...extra };
  const receiptId = digest(JSON.stringify(canonical(core))), body = { ...core, receiptId, createdAt: "2026-10-24T00:00:00.000Z" };
  const value = { ...body, checksum: digest(JSON.stringify(canonical(body))) };
  return { name: `history/saved_product_recoveries/${digest(companyId)}/${month}/${receiptId}.json`, value };
}

test("normal raw dependencies cover first witness publication without self-invalidation, while earlier raw changes expire every later capacity calculation", async t => {
  const f = await fixture(t), reader = createCompanyIntegratedSourceRevision(f.options), company = f.master.companies[A];
  company.runIds = ["earlier", "later"];
  for (const [id, collectedAt] of [["earlier", "2026-05-01T00:00:00Z"], ["later", "2026-09-25T00:00:00Z"]]) {
    await f.write(`outputs/${id}/manifest.json`, { id, collectedAt, checkIn: collectedAt.slice(0, 10), bookingRangeDays: 1, collectionQuality: { status: "complete" } });
    await f.write(`outputs/${id}/products.json`, { count: id === "earlier" ? 14 : 18 });
  }
  await f.write("company_master/companies.json", f.master);
  let prepared = await reader.prepare();
  const scopes = [scope(A, "2026-04"), scope(A, "2026-05"), scope(A, "2026-09"), scope(B, "2026-09")];
  const original = scopes.map(value => reader.forScope(prepared, value));
  const store = createProductCapacityStore({ dataDir: f.root }), companies = new Map([[A, company]]);
  const evidence = [{ companyId: A, productId: "room", productType: "lodging", count: 14, collectedAt: "2026-05-01T00:00:00.000Z", runId: "earlier" }];
  await store.publish(evidence, { companies, sourceRevision: prepared.revision, assertCurrent: async () => {} });
  prepared = await reader.prepare();
  assert.deepEqual(scopes.map(value => reader.forScope(prepared, value)), original, "Deriving a witness from an already tracked normal original is not a new input");
  await store.publish([...evidence, { ...evidence[0], count: 18, collectedAt: "2026-09-25T00:00:00.000Z", runId: "later" }], { companies, sourceRevision: "equivalent-proof", assertCurrent: async () => {} });
  prepared = await reader.prepare();
  assert.deepEqual(scopes.map(value => reader.forScope(prepared, value)), original, "The derived sourceRevision/file checksum cannot form a feedback dependency");
  const earlySeptember = { ...scope(A, "2026-09"), cutoffDate: "2026-09-15" }, early = reader.forScope(prepared, earlySeptember);
  await f.write("outputs/later/products.json", { count: 19 }); prepared = await reader.prepare();
  assert.notEqual(reader.forScope(prepared, scope(A, "2026-09")), original[2]);
  // Invalid cached proof is surfaced even if its bad source was later than the
  // cutoff; after rebuilding the optional cache, the future raw input is absent.
  await store.publish(evidence, { companies, sourceRevision: "verified-rebuild", assertCurrent: async () => {} }); prepared = await reader.prepare();
  assert.equal(reader.forScope(prepared, earlySeptember), early, "A later observation never becomes an earlier capacity dependency");
  await f.write("outputs/earlier/products.json", { count: 15 }); prepared = await reader.prepare();
  assert.notEqual(reader.forScope(prepared, scope(A, "2026-09")), original[2]);
  assert.equal(reader.forScope(prepared, scope(B, "2026-09")), original[3]);
});

test("retained witnesses outside bounded references invalidate only their company and as-of months, with corrupt and review changes falling back visibly", async t => {
  const f = await fixture(t), reader = createCompanyIntegratedSourceRevision(f.options), company = f.master.companies[A];
  await f.write("outputs/omitted/manifest.json", { collectedAt: "2026-05-01T00:00:00Z", status: "complete" });
  await f.write("outputs/future/manifest.json", { collectedAt: "2026-09-25T00:00:00Z", status: "complete" });
  let prepared = await reader.prepare();
  const scopes = [scope(A, "2026-04"), scope(A, "2026-09"), scope(B, "2026-09")], initial = scopes.map(value => reader.forScope(prepared, value));
  const store = createProductCapacityStore({ dataDir: f.root }), companies = new Map([[A, company]]);
  const early = { companyId: A, productId: "room", productType: "lodging", count: 14, collectedAt: "2026-05-01T00:00:00.000Z", runId: "omitted" };
  await store.publish([early], { companies, sourceRevision: "validated-older-source", assertCurrent: async () => {} }); prepared = await reader.prepare();
  const selected = scopes.map(value => reader.forScope(prepared, value));
  assert.equal(selected[0], initial[0]); assert.notEqual(selected[1], initial[1]); assert.equal(selected[2], initial[2]);
  const earlySeptember = { ...scope(A, "2026-09"), cutoffDate: "2026-09-15" }, earlyToken = reader.forScope(prepared, earlySeptember);
  await store.publish([{ ...early, count: 18, collectedAt: "2026-09-25T00:00:00.000Z", runId: "future" }], { companies, sourceRevision: "new-source", assertCurrent: async () => {} }); prepared = await reader.prepare();
  assert.equal(reader.forScope(prepared, earlySeptember), earlyToken);
  const valid = reader.forScope(prepared, scope(A, "2026-09")), cacheFile = path.join(store.directory, digest(JSON.stringify(A)) + ".json");
  await fs.writeFile(cacheFile, "{broken"); prepared = await reader.prepare();
  assert.equal(prepared.companies[A].productCapacity.evidence.length, 0); assert.ok(prepared.companies[A].productCapacity.warning);
  assert.notEqual(reader.forScope(prepared, scope(A, "2026-09")), valid); assert.equal(reader.forScope(prepared, scope(B, "2026-09")), initial[2]);
  await store.publish([early], { companies, sourceRevision: "verified-rebuild", assertCurrent: async () => {} });
  company.manualCorrection = { lodgingBasisTotal: 12 }; await f.write("company_master/companies.json", f.master); prepared = await reader.prepare();
  assert.equal(prepared.companies[A].productCapacity.warning, "PRODUCT_CAPACITY_CACHE_INVALID");
  assert.deepEqual(prepared.companies[A].productCapacity.evidence, []);
});

test("an earlier certified recovery already covers first witness publication in later months and its original remains a scoped dependency", async t => {
  const f = await fixture(t), reader = createCompanyIntegratedSourceRevision(f.options), runId = "old-receipt";
  await f.write(`outputs/${runId}/manifest.json`, { collectedAt: "2026-05-01T00:00:00.000Z", checkIn: "2026-05-01" });
  await f.write(`outputs/${runId}/product.json`, { stock: 14 });
  const receipt = recoveryEnvelope(A, "2026-05", runId, [{ path: `${runId}/product.json`, sha256: digest(await fs.readFile(path.join(f.root, "outputs", runId, "product.json"))) }], { collectedAt: "2026-05-01T00:00:00.000Z" });
  await f.write(receipt.name, receipt.value); let prepared = await reader.prepare();
  const request = scope(A, "2026-09"), before = reader.forScope(prepared, request), other = reader.forScope(prepared, scope(B, "2026-09"));
  const store = createProductCapacityStore({ dataDir: f.root }), companies = new Map([[A, f.master.companies[A]]]);
  await store.publish([{ companyId: A, productId: "room", productType: "lodging", count: 14, collectedAt: receipt.value.collectedAt, runId, source: "verified_saved_product_recovery" }], { companies, sourceRevision: prepared.revision, assertCurrent: async () => {} });
  prepared = await reader.prepare(); assert.equal(reader.forScope(prepared, request), before, "Writing receipt-derived evidence cannot reject its own first monthly publication");
  await f.write(`outputs/${runId}/product.json`, { stock: 13 }); prepared = await reader.prepare();
  assert.notEqual(reader.forScope(prepared, request), before); assert.equal(reader.forScope(prepared, scope(B, "2026-09")), other);
});

test("saved product receipts scope new recovery and original-run changes without any master/history run reference", async t => {
  const f = await fixture(t), reader = createCompanyIntegratedSourceRevision(f.options);
  let prepared = await reader.prepare();
  const tokens = () => Object.fromEntries([A, B].flatMap(id => ["2026-08", "2026-09", "2026-10", "2026-11"].map(month => [id + month, reader.forScope(prepared, scope(id, month))])));
  const initial = tokens(), runId = "legacy-only-recovery";
  await f.write(`outputs/${runId}/manifest.json`, { collectedAt: "2026-09-01T00:00:00.000Z", checkIn: "2026-09-01", bookingRangeDays: 30 });
  await f.write(`outputs/${runId}/products/product.json`, { total: 16, available: 15 });
  prepared = await reader.prepare(); assert.deepEqual(tokens(), initial, "An unowned old run cannot expire unrelated company months");
  const receipt = recoveryEnvelope(A, "2026-09", runId, [{ path: `${runId}/products/product.json`, sha256: digest(await fs.readFile(path.join(f.root, "outputs", runId, "products/product.json"))) }]);
  await f.write(receipt.name, receipt.value); prepared = await reader.prepare();
  const recovered = tokens();
  for (const id of [A, B]) for (const month of ["2026-08", "2026-09", "2026-10", "2026-11"]) {
    assert.equal(recovered[id + month] !== initial[id + month], id === A && month >= "2026-09", `${id} ${month}`);
  }
  assert.equal(await createCompanyIntegratedSourceRevision(f.options)(scope(A, "2026-09")), recovered[A + "2026-09"], "The scoped receipt projection survives restart");
  await f.write(`outputs/${runId}/products/product.json`, { total: 16, available: 0 });
  prepared = await reader.prepare(); const changed = tokens();
  assert.notEqual(changed[A + "2026-09"], recovered[A + "2026-09"], "A source SHA mismatch expires this recovery; the observation reader decides whether to reject it");
  assert.notEqual(changed[A + "2026-10"], recovered[A + "2026-10"]);
  assert.notEqual(changed[A + "2026-11"], recovered[A + "2026-11"], "An older receipt is still a cumulative capacity input in later months");
  for (const key of [A + "2026-08", ...["2026-08", "2026-09", "2026-10", "2026-11"].map(month => B + month)]) assert.equal(changed[key], recovered[key]);
  const before = await fs.readFile(path.join(f.root, "company_integrated/revision-index.json"));
  await f.write(receipt.name, { ...receipt.value, verifiedDates: ["2026-09-01"] });
  await assert.rejects(reader.prepare(), { code: "COMPANY_SOURCE_REVISION_UNAVAILABLE" });
  assert.deepEqual(await fs.readFile(path.join(f.root, "company_integrated/revision-index.json")), before, "Corrupt receipts cannot certify or overwrite the last good source index");
  await f.write(receipt.name, receipt.value); assert.deepEqual(await reader.prepare(), prepared);
  await fs.unlink(path.join(f.root, receipt.name)); prepared = await reader.prepare(); assert.deepEqual(tokens(), initial, "Removing a receipt removes only its scoped dependency");
});

test("receipt source paths, company/month directories and content identity fail closed when malformed", async t => {
  const f = await fixture(t), reader = createCompanyIntegratedSourceRevision(f.options);
  await reader.prepare();
  const runId = "legacy-recovery", original = recoveryEnvelope(A, "2026-09", runId, [{ path: `${runId}/manifest.json`, sha256: "a".repeat(64) }]);
  for (const relative of ["../outside.json", `${runId}/../outside.json`, `${runId}\\product.json`, `${runId}/C:unsafe.json`, "other-run/product.json"]) {
    const invalid = recoveryEnvelope(A, "2026-09", runId, [{ path: relative, sha256: "a".repeat(64) }]);
    await f.write(invalid.name, invalid.value);
    await assert.rejects(reader.prepare(), { code: "COMPANY_SOURCE_REVISION_UNAVAILABLE" });
    await fs.unlink(path.join(f.root, invalid.name));
  }
  for (const name of [original.name.replace(digest(A), digest(B)), original.name.replace("2026-09", "2026-08"), original.name.replace(original.value.receiptId, "a".repeat(64))]) {
    await f.write(name, original.value);
    await assert.rejects(reader.prepare(), { code: "COMPANY_SOURCE_REVISION_UNAVAILABLE" });
    await fs.unlink(path.join(f.root, name));
  }
  await f.write(original.name, "{broken");
  await assert.rejects(reader.prepare(), { code: "COMPANY_SOURCE_REVISION_UNAVAILABLE" });
});

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

test("unrelated companies and future keyword series preserve closed scopes, while effective alias and place owners remain dependencies", async t => {
  const f = await fixture(t), reader = createCompanyIntegratedSourceRevision(f.options);
  let prepared = await reader.prepare();
  const tokens = () => Object.fromEntries([A, B].flatMap(id => ["2026-08", "2026-09", "2026-10"].map(month => [id + month, reader.forScope(prepared, scope(id, month))])));
  const before = tokens(), C = "cmp_place_300";
  f.master.companies[C] = { companyId: C, primaryName: "새 키워드 신규 업체", placeIds: ["300"], addresses: ["시험도 지역200 주소"] };
  await f.write("company_master/companies.json", f.master); prepared = await reader.prepare();
  assert.deepEqual(tokens(), before, "An unrelated canonical identity is not an input of existing company months");
  f.master.companies[A].keywords.future = { keyword: "새 검색 키워드", runs: [{ runId: "future-run", collectedAt: "2026-11-01T00:00:00Z", rank: 7 }] };
  await f.write("outputs/future-run/manifest.json", { collectedAt: "2026-11-01T00:00:00Z", checkIn: "2026-11-01", bookingRangeDays: 21, status: "complete" });
  await f.write("company_master/companies.json", f.master); prepared = await reader.prepare();
  assert.deepEqual(tokens(), before, "A future keyword label/rank/run does not change an earlier company's month");
  const future = reader.forScope(prepared, scope(A, "2026-11"));
  f.master.companies[A].keywords.future.runs[0].rank = 4;
  await f.write("company_master/companies.json", f.master); prepared = await reader.prepare();
  assert.deepEqual(tokens(), before); assert.notEqual(reader.forScope(prepared, scope(A, "2026-11")), future);
  f.master.companies[A].duplicateNotes = [{ mergedCompanyId: "old-company" }];
  f.rows.push({ companyKey: "old-company", runId: "run_100", stayDate: "2026-09-02", sold: 1 });
  await f.history(); await f.write("company_master/companies.json", f.master); prepared = await reader.prepare();
  const beforeReassignment = tokens();
  f.master.companies[C].duplicateNotes = [{ mergedCompanyId: "old-company" }];
  await f.write("company_master/companies.json", f.master); prepared = await reader.prepare();
  assert.notEqual(tokens()[A + "2026-09"], beforeReassignment[A + "2026-09"], "Actual alias ownership changes invalidate its previous owner");
  assert.equal(tokens()[B + "2026-09"], beforeReassignment[B + "2026-09"], "Unrelated identity remains reusable");
  const beforeConflict = tokens();
  f.master.companies[C].placeIds.push("100");
  await f.write("company_master/companies.json", f.master); prepared = await reader.prepare();
  assert.notEqual(tokens()[A + "2026-08"], beforeConflict[A + "2026-08"], "A different company claiming the place changes A's effective resolution");
  assert.notEqual(tokens()[B + "2026-09"], beforeConflict[B + "2026-09"], "The stored global duplicate-company diagnostic is still a real dependency");
});

test("verified observation index matches legacy scope digests without rereading the JSONL body, and index failures preserve last-good revisions", async t => {
  const f = await fixture(t);
  const rawLines = () => [...f.rows.map(JSON.stringify), "malformed", "\uFEFF" + JSON.stringify({ companyKey: A, stayDate: "2026-09-03", runId: "run_100", missing: true }),
    JSON.stringify({ companyKey: "unknown-id", stayDate: "2026-09-04", runId: "unknown-run", sold: null }), "[]", ""];
  await f.write("history/observations.jsonl", rawLines().join("\n") + "\n");
  const legacy = createCompanyIntegratedSourceRevision(f.options), expected = await legacy.prepare();
  const indexFile = path.join(f.root, "company_integrated/revision-index.json");
  await fs.unlink(indexFile);
  let bodyReads = 0, indexedReads = 0, unavailable = false;
  const fileSystem = Object.create(fs);
  fileSystem.open = async (file, ...args) => {
    if (path.resolve(file) === path.join(f.root, "history/observations.jsonl")) { bodyReads++; throw new Error("The indexed revision must not rehash original history"); }
    return fs.open(file, ...args);
  };
  const observationIndex = {
    async ensure() {
      if (unavailable) throw Object.assign(new Error("index unavailable"), { code: "HISTORY_OBSERVATION_INDEX_INVALID" });
      const stat = await fs.lstat(path.join(f.root, "history/observations.jsonl"), { bigint: true });
      return { source: { signature: `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}:${stat.dev}` },
        contentDigest: digest(rawLines().join("\n")), malformedLines: 2 };
    },
    async readLines(query, consume) {
      assert.equal(query.parseMode, "monthly"); indexedReads++;
      for (const [ordinal, line] of rawLines().entries()) {
        let row; try { row = JSON.parse(line.replace(/^\uFEFF/, "")); } catch { continue; }
        if (row && typeof row === "object" && !Array.isArray(row)) await consume(line, row, ordinal + 1);
      }
    }
  };
  const options = { ...f.options, fileSystem, observationIndex, historyStream: () => { throw new Error("Raw history stream is forbidden"); } };
  let reader = createCompanyIntegratedSourceRevision(options), prepared = await reader.prepare();
  assert.deepEqual(prepared, expected, "Index retains order, raw line hashes, BOM parsing, unknowns and malformed diagnostics");
  assert.equal(bodyReads, 0); assert.equal(indexedReads, 1);
  reader = createCompanyIntegratedSourceRevision(options); assert.deepEqual(await reader.prepare(), expected);
  assert.equal(indexedReads, 1, "Unchanged restart reuses the durable revision projection");
  const saved = await fs.readFile(indexFile);
  f.rows.push({ companyKey: A, runId: "run_100", stayDate: "2026-09-07", failed: true });
  await f.write("history/observations.jsonl", rawLines().join("\n") + "\n");
  unavailable = true;
  await assert.rejects(reader.prepare(), { code: "COMPANY_SOURCE_REVISION_UNAVAILABLE" });
  assert.deepEqual(await fs.readFile(indexFile), saved, "Failed verification never replaces the last-good index");
  unavailable = false; prepared = await reader.prepare();
  assert.notEqual(reader.forScope(prepared, scope(A, "2026-09")), legacy.forScope(expected, scope(A, "2026-09")));
  assert.equal(reader.forScope(prepared, scope(B, "2026-09")), legacy.forScope(expected, scope(B, "2026-09")));
  assert.equal(bodyReads, 0);
  assert.throws(() => createCompanyIntegratedSourceRevision({ ...f.options, observationIndex: {} }), TypeError);
});

test("compact raw-identity partitions isolate changed months and reassign merged references without parsing stored observation payloads", async t => {
  const f = await fixture(t), historyFile = path.join(f.root, "history/observations.jsonl"), indexFile = path.join(f.root, "company_integrated/revision-index.json");
  const calls = { partitions: 0, lines: 0, body: 0 }; let corrupt = false;
  async function descriptor() {
    const stat = await fs.lstat(historyFile, { bigint: true });
    return { source: { signature: `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}:${stat.dev}` },
      contentDigest: digest(f.rows.map(JSON.stringify).join("\n")), malformedLines: 0 };
  }
  const observationIndex = {
    ensure: descriptor,
    async readLines() { calls.lines++; throw new Error("Revision checks must use compact partition digests"); },
    async revisionPartitions() {
      calls.partitions++;
      const grouped = new Map();
      for (const [offset, row] of f.rows.entries()) {
        const { companyKey, companyId, placeId, place_id } = row, month = String(row.stayDate || row.date || "").match(/^(\d{4}-(?:0[1-9]|1[0-2]))-\d{2}/)?.[1] || "";
        const refs = { companyKey, companyId, placeId, place_id }, key = JSON.stringify([refs, month]);
        if (!grouped.has(key)) grouped.set(key, { key, ...refs, month, lines: [], count: 0, runIds: new Set() });
        const part = grouped.get(key); part.lines.push(`${offset + 1}:${JSON.stringify(row)}\n`); part.count++;
        if (row.runId) part.runIds.add(String(row.runId));
      }
      const partitions = [...grouped.values()].map(({ lines, runIds, ...part }) => ({ ...part, digest: digest(lines.join("")), runIds: [...runIds] }));
      if (corrupt) partitions[0].count = -1;
      return { ...await descriptor(), partitions };
    }
  };
  const fileSystem = Object.create(fs);
  fileSystem.open = async (file, ...args) => {
    if (path.resolve(file) === historyFile) { calls.body++; throw new Error("Raw history reread is forbidden"); }
    return fs.open(file, ...args);
  };
  const reader = createCompanyIntegratedSourceRevision({ ...f.options, fileSystem, observationIndex,
    historyStream: () => { throw new Error("Raw history stream is forbidden"); } });
  let prepared = await reader.prepare();
  const tokens = () => Object.fromEntries([A, B].flatMap(id => ["2026-08", "2026-09", "2026-10"].map(month => [id + month, reader.forScope(prepared, scope(id, month))])));
  const before = tokens();
  assert.equal(calls.partitions, 1); assert.equal(calls.lines, 0); assert.equal(calls.body, 0);
  f.rows.push({ companyId: A, runId: "run_100", stayDate: "2026-09-04", failed: true }); await f.history(); prepared = await reader.prepare();
  assert.equal(tokens()[A + "2026-08"], before[A + "2026-08"]);
  assert.notEqual(tokens()[A + "2026-09"], before[A + "2026-09"]);
  assert.notEqual(tokens()[A + "2026-10"], before[A + "2026-10"], "Following-month comparison remains a real dependency");
  assert.equal(tokens()[B + "2026-09"], before[B + "2026-09"]);
  f.master.companies[A].duplicateNotes = [{ mergedCompanyId: "legacy-company" }];
  f.rows.push({ companyKey: "legacy-company", runId: "run_100", stayDate: "2026-09-05", value: 4 });
  await f.history(); await f.write("company_master/companies.json", f.master); prepared = await reader.prepare();
  let saved = JSON.parse(await fs.readFile(indexFile));
  assert.equal(saved.parts.history.kind, "canonical-raw-partitions-v1");
  assert.deepEqual(saved.parts.history.runRefs[A]["2026-09"], ["run_100"]);
  const beforeMerge = tokens();
  f.master.companies[A].duplicateNotes = [];
  f.master.companies[B].duplicateNotes = [{ mergedCompanyId: "legacy-company" }];
  await f.write("company_master/companies.json", f.master); prepared = await reader.prepare();
  assert.notEqual(tokens()[A + "2026-09"], beforeMerge[A + "2026-09"]);
  assert.notEqual(tokens()[B + "2026-09"], beforeMerge[B + "2026-09"]);
  saved = JSON.parse(await fs.readFile(indexFile));
  assert.deepEqual(saved.parts.history.runRefs[B]["2026-09"], ["run_100", "run_200"]);
  const lastGood = await fs.readFile(indexFile);
  f.rows.push({ companyKey: A, runId: "run_100", stayDate: "2026-09-06", missing: true }); await f.history(); corrupt = true;
  await assert.rejects(reader.prepare(), { code: "COMPANY_SOURCE_REVISION_UNAVAILABLE" });
  assert.deepEqual(await fs.readFile(indexFile), lastGood);
  assert.equal(calls.lines, 0); assert.equal(calls.body, 0);
});

test("actual SQLite observation index appends only the new bytes and serves restart revisions without original history or payload reads", async t => {
  const { createHistoryObservationIndex } = require("./lib/history_observation_index.cjs");
  const f = await fixture(t), file = path.join(f.root, "history/observations.jsonl"), indexFile = path.join(f.root, "history/observation-index.sqlite");
  let observationIndex = createHistoryObservationIndex({ file, indexFile });
  try {
    let reader = createCompanyIntegratedSourceRevision({ ...f.options, observationIndex }), prepared = await reader.prepare();
    const before = Object.fromEntries([A, B].flatMap(id => ["2026-08", "2026-09", "2026-10"].map(month => [id + month, reader.forScope(prepared, scope(id, month))])));
    const initial = observationIndex.stats();
    assert.equal(initial.sourceReads, 1); assert.equal(initial.rowsRead, 0);
    const newRow = { observationId: "new-A-observation", companyKey: A, runId: "run_100", stayDate: "2026-09-04", failed: true };
    const append = JSON.stringify(newRow) + "\n";
    const receipt = await observationIndex.append(append);
    assert.equal(receipt.indexed, true);
    prepared = await reader.prepare();
    assert.equal(reader.forScope(prepared, scope(A, "2026-08")), before[A + "2026-08"]);
    assert.notEqual(reader.forScope(prepared, scope(A, "2026-09")), before[A + "2026-09"]);
    assert.notEqual(reader.forScope(prepared, scope(A, "2026-10")), before[A + "2026-10"]);
    assert.equal(reader.forScope(prepared, scope(B, "2026-09")), before[B + "2026-09"]);
    assert.equal(observationIndex.stats().bytesReadOriginal - initial.bytesReadOriginal, Buffer.byteLength(append));
    assert.equal(observationIndex.stats().rowsRead, 0, "Partition revision checks do not parse historical observation payloads");
    const beforeKeyword = prepared;
    f.master.companies[B].keywords.future = { keyword: "새로운 지역 검색어", runs: [{ runId: "future-B", collectedAt: "2026-11-01T00:00:00Z", rank: 2 }] };
    await f.write("outputs/future-B/manifest.json", { collectedAt: "2026-11-01T00:00:00Z", checkIn: "2026-11-01", bookingRangeDays: 21, status: "complete" });
    await f.write("company_master/companies.json", f.master);
    assert.equal((await observationIndex.append(JSON.stringify({ observationId: "future-B-row", companyKey: B, keyword: "새로운 지역 검색어",
      runId: "future-B", stayDate: "2026-11-04", missing: true }) + "\n")).indexed, true);
    prepared = await reader.prepare();
    for (const id of [A, B]) for (const month of ["2026-08", "2026-09", "2026-10"]) {
      assert.equal(reader.forScope(prepared, scope(id, month)), reader.forScope(beforeKeyword, scope(id, month)), "A new future keyword/company row does not invalidate historical scopes");
    }
    await observationIndex.close();
    observationIndex = createHistoryObservationIndex({ file, indexFile });
    reader = createCompanyIntegratedSourceRevision({ ...f.options, observationIndex });
    assert.deepEqual(await reader.prepare(), prepared);
    assert.equal(observationIndex.stats().bytesReadOriginal, 0);
    assert.equal(observationIndex.stats().rowsRead, 0);
    f.master.companies.extra = { companyId: "unrelated-company", placeIds: ["444"], primaryName: "추가 업체" };
    await f.write("company_master/companies.json", f.master);
    const afterMaster = await reader.prepare();
    assert.equal(reader.forScope(afterMaster, scope(B, "2026-09")), reader.forScope(prepared, scope(B, "2026-09")));
    assert.equal(observationIndex.stats().bytesReadOriginal, 0);
    assert.equal(observationIndex.stats().rowsRead, 0);
  } finally { await observationIndex.close(); }
});

test("indexed revisions include invalid-date attempts retained by monthly quality accounting", async t => {
  const { createHistoryObservationIndex } = require("./lib/history_observation_index.cjs");
  const f = await fixture(t), file = path.join(f.root, "history/observations.jsonl");
  const observationIndex = createHistoryObservationIndex({ file, indexFile: path.join(f.root, "history/observation-index.sqlite") });
  try {
    const reader = createCompanyIntegratedSourceRevision({ ...f.options, observationIndex });
    const before = await reader.prepare();
    assert.equal((await observationIndex.append(JSON.stringify({ companyKey: A, runId: "run_100", stayDate: "2026-09-xx", productType: "lodging", missing: true }) + "\n")).indexed, true);
    const after = await reader.prepare();
    assert.notEqual(reader.forScope(after, scope(A, "2026-09")), reader.forScope(before, scope(A, "2026-09")));
    assert.notEqual(reader.forScope(after, scope(A, "2026-10")), reader.forScope(before, scope(A, "2026-10")));
    assert.equal(reader.forScope(after, scope(B, "2026-09")), reader.forScope(before, scope(B, "2026-09")));
    assert.equal(observationIndex.stats().rowsRead, 0);
  } finally { await observationIndex.close(); }
});
