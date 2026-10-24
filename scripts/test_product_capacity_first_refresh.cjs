"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createCompanyIntegratedDb } = require("./lib/company_integrated_db.cjs");
const { createCompanyIntegratedSourceRevision } = require("./lib/company_integrated_source_revision.cjs");
const { createMonthlyCompanyRecalculation } = require("./lib/monthly_company_recalculation.cjs");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { compactMonthlyCapacityCompany } = require("./lib/monthly_company_source_catalog.cjs");
const { createProductCapacityStore } = require("./lib/product_capacity_store.cjs");
const { applyInventoryEvidence } = require("./inventory_estimation.cjs");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

test("a company's first normal saved-month refresh publishes witnesses once and remains revision-consistent through comparison reads, warm reuse and restart", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "product-capacity-first-refresh-")), instances = [];
  t.after(async () => { for (const instance of instances) await instance.stop(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("product-capacity-first-refresh-")); await fs.rm(root, { recursive: true, force: true }); });
  const write = async (relative, value) => { const filename = path.join(root, relative); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, typeof value === "string" ? value : JSON.stringify(value)); };
  const companyId = "cmp_place_123", raw = { companyId, primaryName: "검수 전 정상 업체", placeIds: ["123"], bookingBusinessIds: ["456"], lodgingTypes: ["glamping"], addresses: ["시험도 시험군"], manualCorrection: null,
    runIds: ["earlier", "current"], keywords: { broad: { keyword: "광역글램핑", runs: [{ runId: "earlier", collectedAt: "2026-05-01T00:00:00Z", rank: 1 }] }, local: { keyword: "지역글램핑", runs: [{ runId: "current", collectedAt: "2026-09-07T00:00:00Z", rank: 2 }] } } };
  const runs = [{ id: "earlier", keyword: "광역글램핑", collectedAt: "2026-05-01T00:00:00Z", checkIn: "2026-05-01" }, { id: "current", keyword: "지역글램핑", collectedAt: "2026-09-07T00:00:00Z", checkIn: "2026-09-07" }]
    .map(run => ({ ...run, bookingRangeDays: 1, collectedAtSource: "manifest", collectionQuality: { status: "complete" } }));
  const files = ["company_master/companies.json", "history/observations.jsonl", "published_reports/unchanged.json"];
  await write(files[0], { companies: { [companyId]: raw } }); await write(files[1], ""); await write(files[2], { kind: "issued", preserved: true });
  await write("regions.json", { units: [{ regionKey: "test", active: true, selectable: true, level: "local", name: "시험군", fullName: "시험도 시험군" }] });
  const product = (id, stock, date) => ({ bizItemId: id, name: id, saleType: "숙박", date, stock, bookingCount: 0, occupiedBookingCount: 0, price: 100000, open: true });
  for (const run of runs) {
    await write(`outputs/${run.id}/manifest.json`, run);
    await write(`outputs/${run.id}/availability.json`, { items: [{ placeId: "123", checkIn: run.checkIn, bookingRangeDays: 1, dayUsePresence: "absent",
      weeklyProductDetails: [product("room", run.id === "earlier" ? 14 : 7, run.checkIn), product("second", 2, run.checkIn)] }] });
    files.push(`outputs/${run.id}/manifest.json`, `outputs/${run.id}/availability.json`);
  }
  const before = new Map(await Promise.all(files.map(async file => [file, digest(await fs.readFile(path.join(root, file)))])));
  let loads = 0;
  const store = createProductCapacityStore({ dataDir: root });
  const revisionOptions = { dataDir: root, regionMasterFile: path.join(root, "regions.json"), includeContext: false,
    calculationFiles: ["product_capacity_baseline.cjs", "product_capacity_store.cjs", "monthly_company_recalculation.cjs", "monthly_report_sources.cjs"].map(file => path.join(__dirname, "lib", file)) };
  function make() {
    const readRevision = createCompanyIntegratedSourceRevision(revisionOptions);
    const recalculate = createMonthlyCompanyRecalculation({ recalculateAllInventory: true, readPersistedProductCapacityEvidence: companies => store.readForCompanies(companies),
      loadRun: async id => { loads++; return { run: runs.find(run => run.id === id), availability: JSON.parse(await fs.readFile(path.join(root, "outputs", id, "availability.json"), "utf8")) }; },
      companyProductAvailabilityMatch: (company, item) => company.placeIds.includes(item.placeId),
      applyCompanyManualCorrection: item => applyInventoryEvidence({ ...item, inventoryCapacityBaseline: { ...item.inventoryCapacityBaseline, lodging: 16 } }),
      buildHistoryObservations: (value, collectedAt) => value.availability.items.flatMap(item => item.inventoryEvidence.lodging.rows.map(row => ({ ...row,
        companyKey: companyId, runId: value.run.id, keyword: value.run.keyword, collectedAt, stayDate: row.date, productType: "lodging", supply: row.total,
        inventoryEvidenceVersion: item.inventoryEvidence.version, capacityWitnesses: item.inventoryEvidence.lodging.productCapacityEvidence }))) });
    const sources = createMonthlyReportSources({ dataDir: root, regionMasterFile: path.join(root, "regions.json"), listRuns: async () => structuredClone(runs), capacityForCompany: () => 16,
      projectCapacityCompany: compactMonthlyCapacityCompany, readRevision: async () => (await readRevision.prepare()).revision,
      companySourceVersion: "first-capacity-publish-fixture", useSourceReadValidationBoundary: true,
      recalculateCompanyObservations: recalculate, publishProductCapacityEvidence: (evidence, context) => store.publish(evidence, context) });
    const db = createCompanyIntegratedDb({ dataDir: root, loadSources: sources.loadSources, catalog: sources.catalog, listTargets: async () => [{ companyId, months: ["2026-09"] }],
      readRevision, autoStart: false, now: () => new Date("2026-10-24T00:00:00Z") });
    instances.push(db); return { db, readRevision };
  }
  let { db, readRevision } = make();
  const scope = { companyId, month: "2026-09", cutoffDate: "2026-09-30", calculationVersion: "company-integrated-v4-product-max-room-reuse" };
  const originalRevision = await readRevision(scope), result = await db.refreshMonth(companyId, { month: "2026-09" });
  assert.equal(result.status, "ready"); assert.equal(result.snapshot.summary.lodging.sold, 7); assert.equal(result.snapshot.summary.lodging.estimatedRevenue, 700000);
  assert.equal(result.sourceRevision, originalRevision); assert.equal(await readRevision(scope), originalRevision, "First normal witness publication cannot invalidate its own month");
  const evidence = await store.read(raw); assert.equal(evidence.warning, null); assert.equal(evidence.evidence.find(row => row.productId === "room").count, 14);
  const selected = await db.get(companyId, { month: "2026-09" }); assert.equal(selected.status, "ready"); assert.equal(selected.sourceRevision, originalRevision);
  const count = loads; await db.get(companyId, { month: "2026-09" }); assert.equal(loads, count, "A warm selected-month read uses saved results");
  await db.stop(); ({ db, readRevision } = make());
  const restarted = await db.get(companyId, { month: "2026-09" }); assert.equal(restarted.status, "ready"); assert.equal(restarted.sourceRevision, originalRevision); assert.equal(loads, count);
  await db.refreshMonth(companyId, { month: "2026-09" }); assert.equal(await readRevision(scope), originalRevision, "A second calculation stays stable without revision loops");
  for (const file of files) assert.equal(digest(await fs.readFile(path.join(root, file))), before.get(file), `Preserve ${file}`);
});
