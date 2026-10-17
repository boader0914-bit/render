"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { createCompanyCapacityRegistry } = require("./lib/company_capacity_registry.cjs");
const { createCompanyIntegratedTargets } = require("./lib/company_integrated_targets.cjs");

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "company-derived-sources-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
test("capacity baseline is locked, versioned, never marks an estimate reviewed, and corrupt state fails closed", async t => {
  const dataDir = await temporary(t);
  const options = { dataDir, observedCapacity: c => c.observed, reviewedCapacity: c => c.manualCorrection?.active === false ? null : c.manualCorrection?.lodgingBasisTotal };
  const registry = createCompanyCapacityRegistry(options);
  const original = { a: { companyId: "a", observed: 16 } };
  let result = await registry.prepareCompanies(original);
  assert.equal(result.a._integratedCapacity.capacity, 16);
  assert.equal(result.a._integratedCapacity.source, "observed_locked");
  assert.equal(original.a.manualCorrection, undefined, "source untouched");
  result = await registry.prepareCompanies({ a: { ...original.a, observed: 60 } });
  assert.equal(result.a._integratedCapacity.capacity, 16);
  assert.equal(result.a._integratedCapacity.warnings.length, 1);
  const reviewed = { ...original.a, observed: 60, manualCorrection: { lodgingBasisTotal: 60 }, manualCorrectionRevision: 1 };
  result = await registry.prepareCompanies({ a: reviewed });
  assert.equal(result.a._integratedCapacity.capacity, 60, "no arbitrary 40 room limit");
  assert.equal(result.a._integratedCapacity.source, "db_review");
  const filename = path.join(dataDir, "company_integrated", "capacity-bases.json");
  const before = await fs.readFile(filename);
  await createCompanyCapacityRegistry(options).prepareCompanies({ a: reviewed });
  assert.deepEqual(await fs.readFile(filename), before, "unchanged restart is idempotent");
  assert.equal(JSON.parse(before).companies.a.history[0].count, 16);
  const disabled = { companyId: "disabled", observed: 10, manualCorrection: { active: false, lodgingBasisTotal: 99, productStockCorrections: [{ bad: "inactive" }] } };
  result = await registry.prepareCompanies({ disabled });
  assert.equal(result.disabled.manualCorrection.lodgingBasisTotal, 10);
  assert.equal(result.disabled.manualCorrection.productStockCorrections, undefined);
  await fs.writeFile(filename, "{bad");
  await assert.rejects(registry.prepareCompanies(original), /객실 기준/);
});
test("target discovery includes all history, merged IDs, future spans, with no display-name identity merge", async t => {
  const dataDir = await temporary(t);
  await fs.mkdir(path.join(dataDir, "history"));
  const history = [
    null, [], "invalid history row",
    { companyKey: "a", runId: "old", stayDate: "2025-08-01" },
    { companyKey: "merged_a", runId: "new", stayDate: "2026-09-01" },
    { companyKey: "same name", companyName: "same name", runId: "new", stayDate: "2026-01-01" },
    { placeId: "123", runId: "new", stayDate: "2026-10-03" },
    { companyKey: "b", runId: "new", stayDate: "2026-11-01" }
  ];
  await fs.writeFile(path.join(dataDir, "history", "observations.jsonl"), history.map(JSON.stringify).join("\n"));
  const data = { rawCompanies: new Map([
    ["a", { companyId: "a", primaryName: "same name", placeIds: ["123"], duplicateNotes: [{ mergedCompanyId: "merged_a" }], runIds: ["span"] }],
    ["b", { companyId: "b", primaryName: "same name" }]
  ]), runs: [{ id: "span", checkIn: "2026-12-29", bookingRangeDays: 12 }] };
  const list = createCompanyIntegratedTargets({ dataDir, catalog: async () => data });
  assert.deepEqual(await list(), [
    { companyId: "a", months: ["2025-08", "2026-09", "2026-10", "2026-12", "2027-01"] },
    { companyId: "b", months: ["2026-11"] }
  ]);
  assert.deepEqual(await list({ runId: "new", companyIds: ["a"] }), [{ companyId: "a", months: ["2026-09", "2026-10"] }]);
});

test("compact target discovery preserves snapshot run provenance, duplicate-place holds and active identity scope", async t => {
  const dataDir = await temporary(t);
  await fs.mkdir(path.join(dataDir, "history"));
  const historyFile = path.join(dataDir, "history", "observations.jsonl");
  const records = [
    { companyKey: "former-a", runId: "history", stayDate: "2025-07-01" },
    { companyKey: "a", runId: "history", date: "2025-08-01" },
    { placeId: "shared", runId: "history", stayDate: "2025-09-01" },
    { placeId: "unique", runId: "history", stayDate: "2025-10-01" },
    { companyKey: "deleted", runId: "history", stayDate: "2025-11-01" },
    { companyKey: "merged", runId: "history", stayDate: "2025-12-01" },
    { companyKey: "same name", runId: "history", stayDate: "2024-01-01" }
  ];
  const historyText = records.map(JSON.stringify).join("\n");
  await fs.writeFile(historyFile, historyText);
  const rawCompanies = new Map([
    ["a", { companyId: "a", primaryName: "same name", placeIds: ["shared", "unique"], duplicateNotes: [{ mergedCompanyId: "former-a" }],
      keywords: { search: { runs: [{ runId: "span" }] } }, inventory: {
        latest: { runId: "wrapper", productSnapshot: { daily: [
          { stayDate: "2026-02-01", runId: "daily", arbitraryProduct: { preserved: true } },
          { date: "2026-03-01" }
        ] } },
        previousLatest: { runId: "prior", productSnapshot: { daily: [{ stayDate: "2026-04-01" }] } },
        snapshots: [{ runId: "snapshot", productSnapshot: { daily: [{ stayDate: "2026-05-01" }] } }]
      } }],
    ["b", { companyId: "b", primaryName: "same name", placeIds: ["shared"], runIds: ["legacy"] }],
    ["deleted", { companyId: "deleted", deletedAt: "2026-01-01", runIds: ["span"] }],
    ["merged", { companyId: "merged", mergedIntoCompanyId: "a", runIds: ["span"] }]
  ]);
  const data = { rawCompanies, runs: [
    { id: "span", checkIn: "2026-12-29", bookingRangeDays: 12, arbitraryPayload: { preserve: true } },
    { runId: "legacy", checkIn: "2026-06-30", arbitraryPayload: { preserve: true } }
  ] };
  const before = JSON.stringify([...rawCompanies]);
  const runsBefore = JSON.stringify(data.runs);
  const list = createCompanyIntegratedTargets({ dataDir, catalog: async () => data });
  assert.deepEqual(await list(), [
    { companyId: "a", months: ["2025-07", "2025-08", "2025-10", "2026-02", "2026-03", "2026-04", "2026-05", "2026-12", "2027-01"] },
    { companyId: "b", months: ["2026-06"] }
  ]);
  assert.deepEqual(await list({ runId: "daily", companyIds: ["a"] }), [{ companyId: "a", months: ["2026-02"] }]);
  assert.deepEqual(await list({ runId: "wrapper", companyIds: ["a"] }), [{ companyId: "a", months: ["2026-03"] }]);
  assert.deepEqual(await list({ companyIds: ["deleted", "merged"] }), []);
  assert.equal(JSON.stringify([...rawCompanies]), before);
  assert.equal(JSON.stringify(data.runs), runsBefore);
  assert.equal(await fs.readFile(historyFile, "utf8"), historyText);
});

async function targetRetentionChild(moduleFile, root, control) {
  const assert = require("node:assert/strict"), nativeFs = require("node:fs"), fs = require("node:fs/promises"), path = require("node:path");
  const { PassThrough } = require("node:stream");
  let createTargets = require(moduleFile).createCompanyIntegratedTargets;
  if (control) {
    const Module = require("node:module"), text = await fs.readFile(moduleFile, "utf8");
    const retained = text.replace("return { activeIds, companies,", "return { activeIds, companies, _retainedCatalog: data,");
    assert.notEqual(retained, text, "retention control must retain the original full catalog");
    const compiled = new Module(moduleFile, module); compiled.filename = moduleFile;
    compiled.paths = Module._nodeModulePaths(path.dirname(moduleFile)); compiled._compile(retained, moduleFile);
    createTargets = compiled.exports.createCompanyIntegratedTargets;
  }
  await fs.mkdir(path.join(root, "history"), { recursive: true });
  const historyFile = path.join(root, "history", "observations.jsonl");
  await fs.writeFile(historyFile, "");
  const references = [];
  const catalog = () => {
    const payload = { largeUnused: Array.from({ length: 128 }, (_, index) => ({ index, text: Buffer.alloc(4000, index + 1).toString("base64") })) };
    const daily = { stayDate: "2026-09-02", runId: "daily", unusedProducts: payload };
    const snapshot = { runId: "snapshot", productSnapshot: { daily: [daily], rawProducts: payload } };
    const raw = { companyId: "a", placeIds: ["123"], duplicateNotes: [{ mergedCompanyId: "old-a" }], inventory: { latest: snapshot }, runIds: ["span"] };
    const run = { id: "span", checkIn: "2026-12-30", bookingRangeDays: 4, rawProducts: payload };
    const data = { rawCompanies: new Map([["a", raw]]), runs: [run] };
    for (const [name, object] of Object.entries({ catalog: data, rawCompanies: data.rawCompanies, raw, snapshot, daily, payload, run })) references.push({ name, weak: new WeakRef(object) });
    return data;
  };
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new PassThrough();
  const originalReadStream = nativeFs.createReadStream;
  nativeFs.createReadStream = (filename, ...options) => {
    if (path.resolve(filename) !== path.resolve(historyFile)) return originalReadStream(filename, ...options);
    entered(); return blocked;
  };
  let running;
  try {
    running = createTargets({ dataDir: root, catalog: async () => catalog() })();
    await started;
    await new Promise(resolve => setImmediate(resolve)); global.gc();
    const retained = references.filter(reference => reference.weak.deref() !== undefined).map(reference => reference.name);
    if (control) assert.equal(retained.length, references.length);
    else assert.deepEqual(retained, [], "target history scan must not retain full catalog or inventory payloads");
    blocked.end(JSON.stringify({ companyKey: "old-a", runId: "history", stayDate: "2026-08-01" }) + "\n");
    const result = await running;
    console.log(JSON.stringify({ result, retained }));
  } finally {
    blocked.end(); nativeFs.createReadStream = originalReadStream;
    if (running) await running;
  }
}

test("target discovery releases full catalogs before awaiting history while preserving the complete discovery result", async t => {
  const dataDir = await temporary(t);
  const moduleFile = path.join(__dirname, "lib/company_integrated_targets.cjs");
  const script = `(${targetRetentionChild.toString()})(process.argv[1], process.argv[2], process.argv[3] === 'control').catch(error => { console.error(error); process.exitCode = 1; });`;
  const results = ["control", "compact"].map(mode => {
    const child = spawnSync(process.execPath, ["--expose-gc", "-e", script, moduleFile, path.join(dataDir, mode), mode],
      { encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    return JSON.parse(child.stdout.trim());
  });
  assert.deepEqual(results[0].result, [{ companyId: "a", months: ["2026-08", "2026-09", "2026-12", "2027-01"] }]);
  assert.deepEqual(results[1].result, results[0].result);
  assert.equal(results[0].retained.length, 7);
  assert.deepEqual(results[1].retained, []);
});
test("initial room basis uses uncapped full-history raw maxima, never corrected totals or failed zeros", async t => {
  const dataDir = await temporary(t);
  await fs.mkdir(path.join(dataDir, "history"));
  await fs.writeFile(path.join(dataDir, "history", "observations.jsonl"), [
    { companyKey: "a", productType: "lodging", runId: "old", inventoryEvidenceVersion: 4, rawTotal: 21, supply: 99 },
    { companyKey: "a", productType: "lodging", runId: "blocked", inventoryEvidenceVersion: 4, rawTotal: 100 },
    { companyKey: "a", productType: "lodging", runId: "old", inventoryEvidenceVersion: 4, supply: 120 }
  ].map(JSON.stringify).join("\n"));
  const registry = createCompanyCapacityRegistry({ dataDir, observedCapacity: c => c.observed, reviewedCapacity: () => null });
  const result = await registry.prepareCompanies({ a: { companyId: "a", observed: 16 } }, { runs: [{ id: "old", collectionQuality: { status: "complete" } }, { id: "blocked", collectionQuality: { status: "blocked" } }] });
  assert.equal(result.a._integratedCapacity.capacity, 21);
});
test("missing evidence version and explicit provider failures cannot seed fixed capacity", async t => {
  const dataDir = await temporary(t);
  await fs.mkdir(path.join(dataDir, "history"));
  const base = { companyKey: "a", productType: "lodging", runId: "complete", inventoryEvidenceVersion: 4, rawTotal: 22 };
  const rejected = [
    { inventoryEvidenceVersion: undefined }, { inventoryEvidenceVersion: "NaN" }, { inventoryEvidenceVersion: null }, { inventoryEvidenceVersion: 2 }, { inventoryEvidenceVersion: [4] },
    { partial: true }, { missing: true }, { inventoryConflict: true }, { capacityConflict: true }, { collectionFailed: true },
    { failed: true }, { error: "provider error" }, { collectionErrorCode: "BookingAPITooManyRequests", responseStatus: 200 },
    { errors: [{ code: "BookingAPITooManyRequests" }], responseStatus: 200 }, { responseStatus: 429 },
    { sharedDayUseIncomplete: true }, { unknownUnavailable: 1 }, { observationStatus: "unknown" }, { status: "blocked" },
    { inventoryObserved: false }, { stockObserved: false }, { scheduleObserved: false }, { queryAttempted: false }, { runId: "blocked" }, { runId: "unknown" }
  ].map((flags, i) => ({ ...base, rawTotal: 100 + i, ...flags }));
  const records = [null, [], "invalid history record", ...rejected, base,
    { ...base, rawTotal: 0, inventoryObserved: true, stockObserved: true },
    { ...base, rawTotal: 500, supply: 500, missing: true },
    { ...base, rawTotal: [999] }, { ...base, rawTotal: true },
    { ...base, companyKey: "only_zero", rawTotal: 0, inventoryObserved: true, stockObserved: true },
    { ...base, companyKey: "only_failure", rawTotal: 0, missing: true },
    { ...base, companyKey: "only_bad_type", rawTotal: true },
    { ...base, companyKey: "partial_run_valid_row", rawTotal: 61, runId: "partial" }
  ];
  const historyFile = path.join(dataDir, "history", "observations.jsonl");
  await fs.writeFile(historyFile, records.map(JSON.stringify).join("\n"));
  const before = await fs.readFile(historyFile);
  const registry = createCompanyCapacityRegistry({ dataDir, observedCapacity: () => null, reviewedCapacity: () => null });
  const companies = Object.fromEntries(["a", "only_zero", "only_failure", "only_bad_type", "partial_run_valid_row"].map(companyId => [companyId, { companyId }]));
  const runs = ["complete", "blocked", "unknown", "partial"].map(status => ({ id: status, collectionQuality: { status } }));
  const result = await registry.prepareCompanies(companies, { runs });
  assert.equal(result.a._integratedCapacity.capacity, 22);
  for (const id of ["only_zero", "only_failure", "only_bad_type"]) {
    assert.equal(result[id]._integratedCapacity.capacity, null, `${id}: no inferred positive room count`);
    assert.equal(result[id]._integratedCapacity.source, "unknown");
  }
  assert.equal(result.partial_run_valid_row._integratedCapacity.capacity, 61, "independently complete inventory rows from a partial run remain usable; no 40-room cap");
  assert.deepEqual(await fs.readFile(historyFile), before, "source zero and failure records remain distinct and unchanged");
});
test("snapshot callback receives only trusted complete raw dates, including its cached maximum", async t => {
  const dataDir = await temporary(t);
  // Match the existing callback's risky paths: rawTotal, currentObservedMaximum
  // and stockBasis, rather than assuming the callback itself enforces quality.
  const maximum = company => Math.max(0, ...[company.inventory.latest, company.inventory.previousLatest, ...company.inventory.snapshots].filter(Boolean)
    .flatMap(snapshot => [snapshot.stockBasis?.lodgingMaxTotal || 0, snapshot.capacityBasis?.currentObservedMaximum || 0,
      snapshot.productSnapshot?.capacityBasis?.currentObservedMaximum || 0, ...(snapshot.productSnapshot?.daily || []).map(row => row.rawTotal)]));
  const snapshot = (runId, count, extra = {}) => ({ runId, stockBasis: { lodgingMaxTotal: 999 },
    capacityBasis: { currentObservedMaximum: 999 }, productSnapshot: { inventoryEvidenceVersion: 4,
      capacityBasis: { currentObservedMaximum: 999 }, daily: [{ productType: "lodging", rawTotal: count }] }, ...extra });
  const original = { a: { companyId: "a", inventory: {
    latest: snapshot("blocked", 100), previousLatest: snapshot("complete", 16), snapshots: [
      snapshot("unknown", 200), snapshot("complete", 300, { partial: true }),
      snapshot("complete", 400, { productSnapshot: { daily: [{ productType: "lodging", rawTotal: 400 }] } }),
      snapshot("complete", 500, { productSnapshot: { inventoryEvidenceVersion: 4, capacityBasis: { currentObservedMaximum: 500 },
        daily: [{ productType: "lodging", rawTotal: 500, collectionFailed: true }, { productType: "lodging", rawTotal: 15 }] } })
    ]
  } }, b: { companyId: "b", inventory: { latest: snapshot("blocked", 900), snapshots: [] } } };
  const before = JSON.stringify(original);
  const registry = createCompanyCapacityRegistry({ dataDir, observedCapacity: maximum, reviewedCapacity: () => null });
  const runs = ["complete", "blocked", "unknown"].map(status => ({ id: status, collectionQuality: { status } }));
  const result = await registry.prepareCompanies(original, { runs });
  assert.equal(result.a._integratedCapacity.capacity, 16, "failed 100-room snapshot cannot permanently seed baseline; summary 999 cannot bypass row filtering");
  assert.equal(result.b._integratedCapacity.capacity, null, "failed-only snapshot keeps capacity unknown");
  assert.equal(JSON.stringify(original), before, "snapshot filtering is read-only and does not rewrite source snapshots");
  const merged = snapshot("blocked", 17);
  merged.productSnapshot.dailyRunId = "complete";
  const c = await registry.prepareCompanies({ c: { companyId: "c", inventory: { latest: merged } } }, { runs });
  assert.equal(c.c._integratedCapacity.capacity, 17, "retained daily evidence uses its own successful run provenance");
});

test("capacity checkpoints defer a large company preparation while preserving the registry chain and locked quantities", async t => {
  const dataDir = await temporary(t), companies = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`company-${index}`, { companyId: `company-${index}`, observed: 16 }]));
  const original = JSON.stringify(companies);
  let observedCalls = 0, checkpoints = 0, release, entered, secondFinished = false;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const registry = createCompanyCapacityRegistry({ dataDir, observedCapacity: company => { observedCalls++; return company.observed; }, reviewedCapacity: () => null });
  const first = registry.prepareCompanies(companies, { checkpoint: async () => {
    if (++checkpoints === 2) { entered(); await gate; }
  } });
  await waiting;
  assert.ok(observedCalls > 0 && observedCalls < 33, "the checkpoint is between bounded company clones");
  const pausedCalls = observedCalls;
  const second = registry.prepareCompanies({ "company-0": { companyId: "company-0", observed: 70 } }).then(value => { secondFinished = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observedCalls, pausedCalls, "paused work remains paused until its callback resumes");
  assert.equal(secondFinished, false, "a second preparation cannot enter the held registry chain");
  release();
  const prepared = await first, next = await second;
  assert.ok(checkpoints >= 4, "entry, company batches and persistence have cooperative boundaries");
  assert.equal(Object.keys(prepared).length, 33);
  for (const company of Object.values(prepared)) assert.equal(company._integratedCapacity.capacity, 16);
  assert.equal(next["company-0"]._integratedCapacity.capacity, 16, "a later larger observation does not silently replace the fixed basis");
  assert.equal(next["company-0"]._integratedCapacity.source, "observed_locked");
  assert.equal(next["company-0"]._integratedCapacity.warnings.length, 1);
  assert.equal(JSON.stringify(companies), original, "source companies are never mutated while paused or resumed");
});

test("history checkpoints occur on bounded rows and failures release the chain without publishing a partial maximum", async t => {
  const dataDir = await temporary(t), historyFile = path.join(dataDir, "history", "observations.jsonl");
  await fs.mkdir(path.dirname(historyFile), { recursive: true });
  const rows = Array.from({ length: 600 }, (_, index) => ({ companyId: "a", productType: "lodging", runId: "run", inventoryEvidenceVersion: 4, rawTotal: index === 599 ? 80 : 16 }));
  await fs.writeFile(historyFile, rows.map(JSON.stringify).join("\n"));
  const historyBefore = await fs.readFile(historyFile), companies = { a: { companyId: "a" } }, original = JSON.stringify(companies);
  let calls = 0;
  const failure = Object.assign(new Error("cooperative checkpoint rejected"), { code: "TEST_CHECKPOINT_FAILURE" });
  const registry = createCompanyCapacityRegistry({ dataDir, observedCapacity: () => null, reviewedCapacity: () => null });
  const runs = [{ id: "run", collectionQuality: { status: "complete" } }];
  await assert.rejects(registry.prepareCompanies(companies, { runs, checkpoint: async () => {
    if (++calls === 3) throw failure;
  } }), error => error === failure);
  assert.equal(calls, 3, "entry and cache-key checkpoints precede the first 256-row boundary");
  await assert.rejects(fs.readFile(path.join(dataDir, "company_integrated", "capacity-bases.json")), { code: "ENOENT" });
  let resumedCalls = 0;
  const result = await registry.prepareCompanies(companies, { runs, checkpoint: async () => { resumedCalls++; } });
  assert.ok(resumedCalls >= 5, "both 256-row boundaries and persistence are reached on the successful retry");
  assert.equal(result.a._integratedCapacity.capacity, 80, "failed scans do not cache the partial 16-room maximum");
  assert.equal(result.a._integratedCapacity.observedMaximum, 80);
  assert.deepEqual(await fs.readFile(historyFile), historyBefore);
  assert.equal(JSON.stringify(companies), original);
});

test("the saved-basis parse checkpoint propagates its own error and the next preparation can recover", async t => {
  const dataDir = await temporary(t), companies = { a: { companyId: "a", observed: 16 } };
  const registry = createCompanyCapacityRegistry({ dataDir, observedCapacity: company => company.observed, reviewedCapacity: () => null });
  const first = await registry.prepareCompanies(companies), file = path.join(dataDir, "company_integrated", "capacity-bases.json"), saved = await fs.readFile(file);
  await fs.writeFile(file, "{invalid basis");
  let calls = 0;
  const failure = Object.assign(new Error("pause rejected before parse"), { code: "TEST_BEFORE_PARSE" });
  await assert.rejects(registry.prepareCompanies(companies, { checkpoint: async () => { if (++calls === 2) throw failure; } }), error => error === failure);
  assert.equal(calls, 2, "the callback runs after reading but before parsing the saved basis");
  await assert.rejects(registry.prepareCompanies(companies), { code: "CAPACITY_BASIS_UNAVAILABLE" });
  await fs.writeFile(file, saved);
  const recovered = await registry.prepareCompanies(companies, { checkpoint: false });
  assert.deepEqual(recovered, first, "no callback retains the original idempotent results and source basis");
  assert.deepEqual(await fs.readFile(file), saved);
});
