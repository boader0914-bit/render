"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
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
