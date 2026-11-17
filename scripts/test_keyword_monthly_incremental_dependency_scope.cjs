"use strict";
// Synthetic dependency-to-scope integration. Execute exact production AST nodes;
// no copied key/identity/planning implementation, app entry, original data or I/O fixtures.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), vm = require("node:vm");
const H = require("./lib/keyword_monthly_refresh_preparation.cjs");
const sha = x => crypto.createHash("sha256").update(typeof x === "string" || Buffer.isBuffer(x) ? x : JSON.stringify(x)).digest("hex");
const clone = x => structuredClone(x), sorted = x => [...x].sort(), ids = x => sorted(x.map(H.scopeId));
const nativeParser = process.binding("natives")["internal/deps/acorn/acorn/dist/acorn"];
assert.equal(typeof nativeParser, "string");
const parserModule = { exports: {} };
new Function("exports", "module", nativeParser)(parserModule.exports, parserModule);
const sourceFiles = Object.fromEntries(["keyword_monthly_incremental_context.cjs", "keyword_monthly_incremental_state.cjs",
  "keyword_monthly_incremental_inputs.cjs", "keyword_monthly_incremental_plan.cjs"].map(name => {
  const text = fs.readFileSync(path.join(__dirname, "lib", name), "utf8");
  return [name, { text, ast: parserModule.exports.parse(text, { ecmaVersion: "latest", sourceType: "script" }) }];
}));
const compilerText = fs.readFileSync(path.join(__dirname, "reconstruct_keyword_monthly_incremental.cjs"), "utf8");
const compiler = { text: compilerText, ast: parserModule.exports.parse(compilerText, { ecmaVersion: "latest", sourceType: "script" }) };
function nodes(root) {
  const out = [];
  function visit(x) { if (!x || typeof x !== "object") return; if (typeof x.type === "string") out.push(x);
    for (const value of Object.values(x)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === "object") visit(value); }
  visit(root); return out;
}
function one(values, label) { assert.equal(values.length, 1, "exact production node required: " + label); return values[0]; }
const functionNode = (file, name) => one(nodes(file.ast).filter(n => n.type === "FunctionDeclaration" && n.id?.name === name), name);
const declarationNode = (owner, name) => one(nodes(owner).filter(n => n.type === "VariableDeclaration"
  && n.declarations.some(d => d.id.type === "Identifier" && d.id.name === name)), name);
const textOf = (file, node) => file.text.slice(node.start, node.end);
const context = sourceFiles["keyword_monthly_incremental_context.cjs"], stateFile = sourceFiles["keyword_monthly_incremental_state.cjs"];
const inputFile = sourceFiles["keyword_monthly_incremental_inputs.cjs"], planFile = sourceFiles["keyword_monthly_incremental_plan.cjs"];
const createContextNode = functionNode(context, "createContext"), seedNode = functionNode(inputFile, "seedDependencies");
const keyCode = textOf(context, declarationNode(createContextNode, "preparationKeys"));
const neededCode = textOf(context, declarationNode(createContextNode, "needed"));
const contextPrelude = ["sha", "identityToken"].map(name => textOf(context, declarationNode(context.ast, name))).join("\n");
const dependencyCode = textOf(context, functionNode(context, "companyDependencyKeywords"));
const dirtyKeywordUpdate = textOf(context, one(nodes(createContextNode).filter(n => n.type === "ExpressionStatement"
  && n.expression.type === "AssignmentExpression" && n.expression.left.type === "MemberExpression"
  && n.expression.left.property.name === "dirtyKeywords" && nodes(n.expression.right).some(c => c.type === "CallExpression"
    && c.callee.type === "Identifier" && c.callee.name === "companyDependencyKeywords")), "dirty keyword dependency propagation"));
const seedPrelude = ["CAPACITY_BASES", "hash", "digest", "need"].map(name => textOf(inputFile, declarationNode(inputFile.ast, name))).join("\n")
  + "\n" + textOf(inputFile, functionNode(inputFile, "globalSeedContentHash"));
const globalPush = one(nodes(seedNode).filter(n => n.type === "ExpressionStatement" && n.expression.type === "CallExpression"
  && n.expression.callee.type === "MemberExpression" && n.expression.callee.object.name === "globalFiles"
  && n.expression.callee.property.name === "push"), "globalFiles.push");
const seedReturn = one(nodes(seedNode).filter(n => n.type === "ReturnStatement" && n.argument?.type === "ObjectExpression"
  && n.argument.properties.some(p => p.key?.name === "globalDependencySha256")), "seed global return");
const globalExpression = one(seedReturn.argument.properties.filter(p => p.key?.name === "globalDependencySha256"), "globalDependencySha256").value;
const inputFingerprintCode = textOf(compiler, declarationNode(functionNode(compiler, "compile"), "inputsFingerprint"));
const identityCode = textOf(stateFile, declarationNode(functionNode(stateFile, "apply"), "identity"));
const identityIf = one(nodes(functionNode(stateFile, "apply")).filter(n => n.type === "IfStatement"
  && n.consequent.type === "ExpressionStatement" && n.consequent.expression.type === "AssignmentExpression"
  && n.consequent.expression.left.type === "MemberExpression" && n.consequent.expression.left.property.name === "globalDiagnosticsDirty"), "identity global flag");
const planPrelude = textOf(planFile, declarationNode(planFile.ast, "VERSION"));
const planCode = textOf(planFile, functionNode(planFile, "planScopes"));
const pureH = Object.freeze({ hash: H.hash, need: H.need, scopeId: H.scopeId, nextMonth: H.nextMonth, MONTH: H.MONTH, SHA: H.SHA });
function evaluate(code, values) {
  return new vm.Script('"use strict";\n' + code, { filename: "exact-production-dependency-nodes.cjs" })
    .runInNewContext({ crypto, Buffer, ...values }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
}
const CODE = sha("unchanged-source-code"), OWNERSHIP = sha("unchanged-full-ownership"), REGIONS = [{ regionKey: "synthetic-region" }];
const K = Object.freeze({ a: "합성 A", a2: "합성 A 두번째", b: "합성 B", c: "합성 C", d: "합성 booking 공유", part: "합성 partition 전용", run: "합성 run 유래",
  untouched: "합성 보존", current: "합성 현재 수집" });
const stamp = n => ({ dev: "1", ino: String(n), size: "1", mtimeNs: String(n), ctimeNs: String(n), mode: "33152", nlink: "1" });
function fixture() {
  const company = (companyId, place, keywords, duplicateNotes = []) => ({ companyId, orderIndex: 0, sha256: sha("raw-" + companyId),
    compact: { companyId, placeIds: [place], bookingBusinessIds: ["booking-" + companyId], duplicateNotes,
      keywords: Object.fromEntries(keywords.map((keyword, i) => [i, { keyword, runs: [{ runId: "own-" + companyId }] }])),
      inventory: { latest: { runId: "own-" + companyId } } } });
  const companies = [company("a", "111", [K.a, K.a2], [{ mergedCompanyId: "legacy-a" }]),
    company("b", "222", [K.b], [{ mergedCompanyId: "legacy-a" }]), company("c", "222", [K.c]),
    company("d", "333", [K.d]), company("u", "999", [K.untouched])];
  companies.find(c => c.companyId === "d").compact.bookingBusinessIds = ["booking-a"];
  companies.forEach((c, i) => { c.orderIndex = i; });
  const runs = companies.map(c => ({ id: "own-" + c.companyId, keyword: c.compact.keywords[0].keyword,
    collectionQuality: { status: "complete" }, collectedAt: "2026-11-01T00:00:00.000Z", collectedAtSource: "manifest",
    checkIn: "2026-11-01", bookingRangeDays: 30 }));
  runs.push({ id: "partition-run", keyword: K.run, collectionQuality: { status: "complete" }, collectedAt: "2026-01-02T00:00:00.000Z",
    collectedAtSource: "manifest", checkIn: "2025-12-31", bookingRangeDays: 2 });
  const part = { key: "synthetic-partition", companyKey: "legacy-a", companyId: "", placeId: "111", month: "2025-09",
    keywords: [K.part], runIds: ["partition-run"], digest: sha("unchanged-history-partition") };
  const catalog = { scopes: [[K.a, "2026-10"], [K.a, "2026-11"], [K.a2, "2026-09"], [K.b, "2026-08"],
    [K.c, "2026-07"], [K.d, "2026-06"], [K.part, "2025-09"], [K.run, "2025-12"], [K.run, "2026-01"],
    [K.untouched, "2024-02"], [K.untouched, "2026-11"], [K.current, "2026-11"]].map(([keyword, month], i) =>
      ({ keyword, month, partition: i < 3 || keyword === K.untouched ? sha("shared-old-partition") : sha("old-partition-" + i) })) };
  return { state: { companies, history: { partitions: [part] }, runs, dirtyCompanyIds: [], dirtyMonths: [], dirtyKeywords: [],
      globalDiagnosticsDirty: false, staticInputsFingerprint: null },
    basis: { schemaVersion: 1, companies: { a: { count: 10, revision: 1 }, b: { count: 8, revision: 1 }, c: { count: 6, revision: 1 }, d: { count: 5, revision: 1 }, u: { count: 4, revision: 1 } } },
    catalog, codeFingerprint: CODE, ownershipFingerprint: OWNERSHIP, regions: clone(REGIONS),
    specialBody: '{"year":2026,"updatedAt":"2026-11-01T00:00:00.000Z"}', recoveryBody: '{"verified":true,"revision":1}',
    capacityStamp: stamp(1), specialStamp: stamp(2), recoveryStamp: stamp(3), directoryStamp: stamp(4) };
}
function globalSeedFingerprint(f) {
  const rows = [
    { relative: "company_integrated/capacity-bases.json", body: JSON.stringify(f.basis), stamp: f.capacityStamp },
    { relative: "history/special_days/2026.json", body: f.specialBody, stamp: f.specialStamp },
    { relative: "history/saved_product_recoveries/proof.json", body: f.recoveryBody, stamp: f.recoveryStamp }
  ].map(r => ({ ...r, bytes: Buffer.from(r.body) }));
  const before = { roots: [{ relative: "company_integrated/capacity-bases.json", present: true, directory: false },
    { relative: "history/special_days", present: true, directory: true }, { relative: "history/saved_product_recoveries", present: true, directory: true }],
    directories: [{ relative: "history/special_days", stamp: f.directoryStamp }, { relative: "history/saved_product_recoveries", stamp: stamp(5) }] };
  const globalFiles = [];
  for (const row of rows) evaluate(seedPrelude + "\n" + textOf(inputFile, globalPush), {
    H: pureH, row: { relative: row.relative, bytes: row.bytes.length, stamp: row.stamp }, bytes: row.bytes,
    sourceHash: sha(row.bytes), globalFiles, before });
  return evaluate(seedPrelude + "\n(" + textOf(inputFile, globalExpression) + ")", { H: pureH, globalFiles, before });
}
function inputFingerprint(f) {
  return evaluate(inputFingerprintCode + "\ninputsFingerprint", { H: pureH, seeded: { globalDependencySha256: globalSeedFingerprint(f) },
    context: { wiring: { bindings: { codeFingerprint: f.codeFingerprint } } }, regions: f.regions });
}
function preparation(f) {
  return evaluate(contextPrelude + "\n" + keyCode + "\n" + neededCode + "\n({ keys: preparationKeys, needed })", {
    state: f.state, basis: f.basis, wiring: { bindings: { codeFingerprint: f.codeFingerprint } },
    historicalOwnershipFingerprint: f.ownershipFingerprint, runMap: new Map(f.state.runs.map(r => [r.id || r.runId, r])) });
}
function prime(f) {
  const result = preparation(f);
  for (const e of f.state.companies) e.preparationKey = result.keys.get(e.companyId);
  f.state.staticInputsFingerprint = inputFingerprint(f);
  assert.deepEqual(f.state.dirtyCompanyIds, []); assert.deepEqual(f.state.dirtyKeywords, []); assert.equal(f.state.globalDiagnosticsDirty, false);
  return f;
}
function connectedKeywords(f, changedIds) {
  return evaluate(contextPrelude + "\n" + dependencyCode + "\ncompanyDependencyKeywords({ companies, companyIds, partitions, runs })", {
    companies: f.state.companies, companyIds: changedIds, partitions: f.state.history.partitions, runs: f.state.runs });
}
function scopes(f, neededIds) {
  const state = clone(f.state), needed = state.companies.filter(e => neededIds.includes(e.companyId));
  evaluate(contextPrelude + "\n" + dependencyCode + "\n" + dirtyKeywordUpdate, {
    state, needed, runs: state.runs });
  return evaluate(planPrelude + "\n" + planCode + "\nplanScopes(input)", { H: pureH,
    input: { state, catalog: f.catalog, evidence: { keyword: K.current }, range: { stayMonths: ["2026-11"], collectionMonth: "2026-11" },
      capturedAt: "2026-11-17T00:05:30.708Z", inputsFingerprint: inputFingerprint(f) } });
}
function result(f) { const p = preparation(f), needed = Array.from(p.needed, e => e.companyId); return { keys: p.keys, needed, plan: scopes(f, needed) }; }
function unchangedOthers(before, after, changed) { for (const id of ["a", "b", "c", "d", "u"]) if (!changed.includes(id)) assert.equal(after.keys.get(id), before.keys.get(id), "untouched key " + id); }
function preserveBindings(f, plan) {
  const generationDir = path.resolve(__dirname, "..", "synthetic-never-created-generation"), before = JSON.stringify(f.catalog);
  const replacements = plan.scopes.map((s, i) => ({ directory: path.join(generationDir, "new-" + i), exposeScopes: [{ keyword: s.keyword, month: s.month }] }));
  const merged = H.mergeInputs({ catalog: f.catalog, generationDir }, replacements), actual = new Map();
  for (const item of merged) for (const scope of item.exposeScopes) actual.set(H.scopeId(scope), item.directory);
  const changed = new Set(ids(plan.scopes));
  for (const old of f.catalog.scopes) if (!changed.has(H.scopeId(old))) assert.equal(actual.get(H.scopeId(old)),
    path.join(generationDir, "partitions", old.partition), "exact untouched partition binding");
  assert.equal(JSON.stringify(f.catalog), before, "planning/merging did not mutate source catalog");
  for (const row of replacements) assert.equal(actual.get(H.scopeId(row.exposeScopes[0])), row.directory);
  return actual;
}
function identityFlag(old, next) {
  return evaluate(identityCode + "\n" + textOf(stateFile, identityIf) + "\nstate.globalDiagnosticsDirty", {
    old, change: { company: next }, state: { globalDiagnosticsDirty: false } });
}
test("capacity entry add/change/delete and audit history change real preparation keys without global invalidation", () => {
  const cases = [
    ["add", f => { delete f.basis.companies.a; }, f => { f.basis.companies.a = { count: 10, revision: 1 }; }, ["a"]],
    ["change", () => {}, f => { f.basis.companies.a.count = 11; }, ["a"]],
    ["delete", () => {}, f => { delete f.basis.companies.a; }, ["a"]],
    ["revision/history", () => {}, f => { Object.assign(f.basis.companies.a, { revision: 2, updatedAt: "2026-11-17T01:00:00Z", history: [{ count: 9 }] }); }, ["a"]],
    ["unrelated unknown entry", () => {}, f => { f.basis.companies.orphan = { count: 99, revision: 1 }; }, []],
    ["other known entry", () => {}, f => { f.basis.companies.u.count = 5; }, ["u"]]
  ];
  for (const [name, setup, edit, expected] of cases) {
    const initial = fixture(); setup(initial); prime(initial); const base = result(initial), changed = clone(initial); edit(changed); changed.capacityStamp = stamp(100);
    const after = result(changed); assert.deepEqual(sorted(after.needed), sorted(expected), name); unchangedOthers(base, after, expected);
    assert.equal(inputFingerprint(changed), inputFingerprint(initial), name + " global seed remains stable");
    assert.equal(after.plan.globalDependencyChange, false, name); assert.equal(after.plan.rawHistoryRescanRequired, false); preserveBindings(changed, after.plan);
  }
});
test("actual dependency closure follows multiple keywords, duplicate aliases, place and booking-only collisions plus partition/run exposures", () => {
  const f = prime(fixture()); f.basis.companies.a.count++;
  const out = result(f); assert.deepEqual(out.needed, ["a"]);
  const keywords = Array.from(connectedKeywords(f, out.needed));
  assert.deepEqual(sorted(keywords), sorted([K.a, K.a2, K.b, K.c, K.d, K.part, K.run]));
  for (const s of f.catalog.scopes) if (s.keyword !== K.untouched) assert.ok(ids(out.plan.scopes).includes(H.scopeId(s)), "required exposure " + H.scopeId(s));
  assert.equal(out.plan.scopes.some(s => s.keyword === K.untouched), false);
  assert.ok(out.plan.scopes.some(s => s.keyword === K.part && s.month === "2025-09" && s.reasons.includes("saved_raw_observation_month")));
  assert.ok(out.plan.scopes.some(s => s.keyword === K.run && s.month === "2025-12" && s.reasons.includes("actual_run_recorded_stay_month")));
  assert.ok(out.plan.scopes.some(s => s.keyword === K.run && s.month === "2026-01" && s.reasons.includes("actual_rank_run_month")));
  preserveBindings(f, out.plan);
});
test("any changed raw company blob invalidates its real key for rank, dates, product, prices, shared inventory and capacity corrections", () => {
  const changes = [
    { ranks: [{ rank: 2 }] }, { stayDate: "2026-12-01" }, { productType: "dayuse" }, { publicPrice: 0 }, { phonePrice: null },
    { sharedDayUse: true }, { productCapacityCorrectionSignature: "review-v2" }, { maximumRoomCapacity: 0 }
  ];
  for (const payload of changes) {
    const initial = prime(fixture()), before = result(initial), f = clone(initial);
    f.state.companies[0].sha256 = sha({ originalBlob: "a", changedOriginalFields: payload });
    const out = result(f); assert.deepEqual(out.needed, ["a"]); unchangedOthers(before, out, ["a"]);
    assert.equal(out.plan.globalDependencyChange, false); assert.ok(out.plan.scopes.some(s => s.keyword === K.a)); preserveBindings(f, out.plan);
  }
});
test("history digest, run quality and complete ownership/code/region dependencies retain their distinct invalidation scopes", () => {
  const edits = [
    ["partition digest", f => { f.state.history.partitions[0].digest = sha("changed-history"); }, ["a", "b"], false],
    ["run quality", f => { f.state.runs.find(r => r.id === "own-a").collectionQuality = { status: "partial" }; }, ["a"], false],
    ["full ownership population", f => { f.ownershipFingerprint = sha("changed-full-ownership"); }, ["a", "b", "c", "d", "u"], false],
    ["code", f => { f.codeFingerprint = sha("changed-source-code"); }, ["a", "b", "c", "d", "u"], true],
    ["region", f => { f.regions.push({ regionKey: "new-region" }); }, [], true]
  ];
  for (const [name, edit, expected, global] of edits) {
    const initial = prime(fixture()), before = result(initial), f = clone(initial); edit(f);
    const out = result(f); assert.deepEqual(sorted(out.needed), sorted(expected), name); unchangedOthers(before, out, expected);
    assert.equal(out.plan.globalDependencyChange, global, name);
    if (global || expected.includes("u")) for (const s of f.catalog.scopes) assert.ok(ids(out.plan.scopes).includes(H.scopeId(s)), name + " retains all old scopes");
    preserveBindings(f, out.plan);
  }
});
test("real store identity predicate keeps place, booking, merge and deletion changes global, but not price-only changes", () => {
  const initial = prime(fixture()), old = clone(initial.state.companies[0].compact);
  const edits = [
    c => { c.placeIds.push("new-place"); }, c => { c.bookingBusinessIds.push("new-booking"); },
    c => { c.duplicateNotes.push({ mergedCompanyId: "old-owner" }); }, c => { c.deletedAt = "2026-11-17T00:00:00Z"; },
    c => { c.mergedIntoCompanyId = "b"; }
  ];
  for (const edit of edits) {
    const f = clone(initial), next = clone(old); edit(next); f.state.globalDiagnosticsDirty = identityFlag(old, next);
    assert.equal(f.state.globalDiagnosticsDirty, true); const out = result(f); assert.equal(out.plan.globalDependencyChange, true);
    for (const s of f.catalog.scopes) assert.ok(ids(out.plan.scopes).includes(H.scopeId(s))); preserveBindings(f, out.plan);
  }
  const price = { ...old, publicPrice: 0, maximumRoomCapacity: 10 }; assert.equal(identityFlag(old, price), false);
});
test("real seed and compiler expressions keep other seeds/global metadata global and reject unsupported capacity schema before planning", () => {
  const edits = [
    f => { f.basis.futureGlobalRule = "reviewed-v2"; },
    f => { f.specialBody = '{"year":2026,"updatedAt":"2026-11-02T00:00:00.000Z"}'; },
    f => { f.recoveryBody = '{"verified":true,"revision":2}'; },
    f => { f.specialStamp = stamp(200); }, f => { f.directoryStamp = stamp(201); }
  ];
  for (const edit of edits) {
    const f = prime(fixture()); edit(f); const out = result(f);
    assert.equal(out.plan.globalDependencyChange, true);
    for (const s of f.catalog.scopes) assert.ok(ids(out.plan.scopes).includes(H.scopeId(s))); preserveBindings(f, out.plan);
  }
  for (const invalid of [{ schemaVersion: 2, companies: {} }, { schemaVersion: 1, companies: null }, { schemaVersion: 1, companies: [] }]) {
    const f = prime(fixture()); f.basis = invalid;
    assert.throws(() => result(f), { code: "KEYWORD_INCREMENTAL_CAPACITY_SEED_INVALID" });
  }
});
test("untouched scopes sharing an old partition retain exact bindings with no pre-existing dirty state masking a missing dependency", () => {
  const f = prime(fixture()), clean = result(f);
  assert.deepEqual(clean.needed, []); assert.deepEqual(ids(clean.plan.scopes), ids([{ keyword: K.current, month: "2026-11" }]));
  const oldState = JSON.stringify(f.state), oldCatalog = JSON.stringify(f.catalog), all = preserveBindings(f, clean.plan);
  assert.equal(all.size, f.catalog.scopes.length);
  f.basis.companies.a.count++; const dirty = result(f), bindings = preserveBindings(f, dirty.plan);
  const retained = f.catalog.scopes.filter(s => s.keyword === K.untouched);
  assert.equal(retained.length, 2);
  for (const s of retained) assert.equal(bindings.get(H.scopeId(s)), path.join(path.resolve(__dirname, "..", "synthetic-never-created-generation"), "partitions", s.partition));
  assert.equal(JSON.stringify(f.state), oldState); assert.equal(JSON.stringify(f.catalog), oldCatalog);
});
test("pre-existing dirty IDs, keywords and both global branches remain authoritative after capacity-only optimization", () => {
  const initial = prime(fixture());
  // The observed 09:00 run had BOTH diagnostics=true and static mismatch.
  // A local-basis optimization is never permission to clear either pending input.
  for (const mode of ["diagnostics", "static", "both"]) {
    const f = clone(initial); f.state.dirtyCompanyIds = ["u"]; f.state.dirtyKeywords = [K.part];
    f.state.globalDiagnosticsDirty = mode !== "static";
    if (mode !== "diagnostics") f.state.staticInputsFingerprint = sha("previous-static-inputs");
    f.basis.companies.a.count++;
    const preserved = JSON.stringify(f.state), out = result(f);
    assert.equal(out.plan.globalDependencyChange, true, mode);
    for (const s of f.catalog.scopes) assert.ok(ids(out.plan.scopes).includes(H.scopeId(s)), mode);
    assert.equal(JSON.stringify(f.state), preserved, "planning does not clear original pending state");
    preserveBindings(f, out.plan);
  }
  const f = clone(initial); f.state.dirtyCompanyIds = ["u"]; f.state.dirtyKeywords = [K.part];
  const out = result(f); assert.deepEqual(out.needed, []);
  assert.equal(out.plan.globalDependencyChange, false);
  assert.ok(out.plan.scopes.some(s => s.keyword === K.untouched));
  assert.ok(out.plan.scopes.some(s => s.keyword === K.part));
  assert.equal(out.plan.scopes.some(s => s.keyword === K.a), false);
  assert.deepEqual(f.state.dirtyCompanyIds, ["u"]); assert.deepEqual(f.state.dirtyKeywords, [K.part]);
});
// Scope limit: store.apply retaining old keyword exposures is covered by its own tests;
// these tests start with an already committed catalog and exercise the exact preparation-to-plan chain.
