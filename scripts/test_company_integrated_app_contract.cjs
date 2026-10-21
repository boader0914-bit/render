"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8").replace(/\r\n/g, "\n");
const stableStart = source.indexOf("function stableJson(value) {");
const stableEnd = source.indexOf("\nfunction crawlPayloadSignature(", stableStart);
const writerStart = source.indexOf("async function readStoredCompanyIntegrationSignatures() {");
const writerEnd = source.indexOf("\nfunction companySourceKeys(", writerStart);
assert.ok(stableStart > 0 && stableEnd > stableStart && writerStart > 0 && writerEnd > writerStart,
  "exercise the real app signature comparison and durable writer, without starting a server");
const writer = source.slice(stableStart, stableEnd) + "\n" + source.slice(writerStart, writerEnd);
const company = (companyId, extra = {}) => ({ companyId, primaryName: companyId, manualCorrection: { lodgingBasisTotal: 16 }, ...extra });

async function fixture(t, initial = { companies: { a: company("a"), b: company("b") } }, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "company-integrated-app-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "companies.json");
  if (initial !== null) await fsp.writeFile(file, typeof initial === "string" ? initial : JSON.stringify(initial));
  const events = [];
  const createWriter = () => {
    const context = vm.createContext({
      Map, Date, Object, Array, JSON, Error, crypto,
      COMPANY_MASTER_FILE: file, COMPANY_MASTER_DIR: root,
      process: { pid: process.pid },
      fsp: options.fileSystem || fsp,
      companyBootstrapStore: { invalidate: () => events.push({ type: "bootstrap" }) },
      invalidateIndustryAnalysis: async reason => events.push({ type: "industry", reason }),
      queueIntegratedCompanies: async (companyIds, reason) => events.push({ type: "queue", companyIds: Array.from(companyIds), reason })
    });
    vm.runInContext(writer, context, { filename: "company-integrated-app-contract.vm.cjs" });
    return context.writeCompanyMaster;
  };
  return { file, events, createWriter, write: createWriter(), read: async () => JSON.parse(await fsp.readFile(file, "utf8")) };
}

function queued(f) { return f.events.filter(event => event.type === "queue").map(event => event.companyIds); }

test("source ingestion persists distinct affected companies without opening the full catalog or discovering months", async () => {
  const start = source.indexOf("async function queueIntegratedCompanies("), end = source.indexOf("\nconst monthlyReportService", start);
  const calls = [], ids = Array.from({length: 20}, (_, i) => `cmp_place_${i + 1000}`);
  const context = { Set, console, companyIntegratedDb: {
    queueRun: async () => { throw new Error("ingestion must not discover all source months"); },
    queueCompany: async (id, options) => { calls.push({id, options}); }
  } };
  vm.runInNewContext(source.slice(start, end), context);
  await context.queueIntegratedCompanies([...ids, ids[0]], "observations_saved");
  assert.deepEqual(calls.map(call => call.id), ids);
  for (const {options} of calls) {
    assert.equal(options.reason, "observations_saved");
    assert.equal(Object.hasOwn(options, "months"), false, "background worker discovers both old and new months");
  }
});

test("the app supplies a dedicated scoped context revision reader and retains its prepared-index methods", async () => {
  const start = source.indexOf("function companyIntegratedCalculationFingerprint() {");
  const end = source.indexOf("\nasync function queueIntegratedCompanies(", start);
  assert.ok(start > 0 && end > start);
  const manifest = source.slice(start, end).match(/const callbacks = \[([\s\S]*?)\];/);
  assert.ok(manifest, "inline calculation dependencies are explicit rather than scanning all app code");
  const callbackNames = manifest[1].split(",").map(name => name.trim());
  assert.ok(callbackNames.every(name => /^[A-Za-z_]\w*$/.test(name)));
  for (const name of ["companyHistoryObservationWithCurrentCapacity", "manualCorrectionLodgingBasisTotal", "companyMaximumRoomCapacity",
    "applyCompanyManualCorrection", "companyProductAvailabilityMatch", "buildHistoryObservations", "companyInventorySnapshotWithCurrentCapacity",
    "inventoryEstimateBreakdown", "historySeriesForItem"]) assert.ok(callbackNames.includes(name), `${name} changes must invalidate saved calculations`);
  const callbacks = Object.fromEntries(callbackNames.map(name => [name, Function(`return function ${name}() {};`)()]));
  let revisionOptions, dbOptions;
  const revision = async scope => `company:${scope.companyId}:${scope.month}`;
  revision.prepare = async () => ({ revision: "prepared", companies: {} });
  revision.forScope = () => "scoped-token";
  const context = {
    path, __dirname, crypto, ...callbacks,
    DATA_DIR: path.join(os.tmpdir(), "unused-contract-data"), OUTPUTS_DIR: path.join(os.tmpdir(), "unused-contract-outputs"),
    WEB_DIR: path.join(os.tmpdir(), "unused-contract-web"),
    monthlyReportSources: { loadSources() {}, catalog() {} }, listCompanyIntegratedTargets() {},
    companyIntegratedCatalog: { catalog() {} },
    runAnalyticalWork: operation => operation(),
    createCompanyIntegratedSourceRevision: options => { revisionOptions = options; return revision; },
    createCompanyIntegratedDb: options => { dbOptions = options; return {}; }
  };
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(revisionOptions.includeContext, true, "tourism/KOSIS/search/special-day context changes participate");
  assert.equal(revisionOptions.dataDir, context.DATA_DIR);
  assert.equal(revisionOptions.outputsDir, context.OUTPUTS_DIR);
  assert.equal(revisionOptions.regionMasterFile, path.join(context.WEB_DIR, "data", "region_master.json"));
  assert.equal(revisionOptions.tourismRegionMapFile, path.join(context.WEB_DIR, "data", "tourism_region_map.json"));
  assert.equal(revisionOptions.calculationFiles.length, 13);
  assert.ok(revisionOptions.calculationFiles.includes(path.join(__dirname, "lib", "company_master_stream.cjs")));
  assert.ok(revisionOptions.calculationFiles.every(file => fs.statSync(file).isFile()));
  assert.ok(revisionOptions.calculationFiles.includes(path.join(__dirname, "lib", "company_integrated_db.cjs")));
  assert.ok(revisionOptions.calculationFiles.includes(path.join(__dirname, "inventory_estimation.cjs")));
  assert.ok(revisionOptions.calculationFiles.includes(path.join(__dirname, "verified_room_inventory.json")));
  assert.ok(revisionOptions.calculationFiles.includes(path.join(__dirname, "lib", "inventory_manual_corrections.cjs")));
  assert.ok(revisionOptions.calculationFiles.includes(path.join(__dirname, "lib", "industry_analysis.cjs")));
  assert.ok(revisionOptions.calculationFiles.includes(path.join(__dirname, "lib", "monthly_report_insights.cjs")));
  assert.ok(!revisionOptions.calculationFiles.includes(path.join(__dirname, "glamping_app_server.cjs")),
    "unrelated server/UI changes must not invalidate every integrated month");
  assert.ok(!revisionOptions.calculationFiles.includes(path.join(__dirname, "lib", "company_integrated_catalog.cjs")),
    "metadata read caching uses its own projection version rather than invalidating all monthly calculations");
  assert.equal(dbOptions.readRevision, revision);
  assert.equal(dbOptions.runWork, context.runAnalyticalWork);
  assert.equal(dbOptions.readRevision.prepare, revision.prepare);
  assert.equal(dbOptions.readRevision.forScope, revision.forScope);
  assert.equal(dbOptions.loadSources, context.monthlyReportSources.loadSources);
  assert.equal(dbOptions.catalog, context.companyIntegratedCatalog.catalog,
    "saved company reads bypass full booking catalog preparation");
  assert.equal(await dbOptions.readRevision({ companyId: "a", month: "2026-09" }), "company:a:2026-09");
  const originalFingerprint = revisionOptions.calculationFingerprint;
  assert.match(originalFingerprint, /^[a-f0-9]{64}$/);
  vm.runInNewContext(source.slice(start, end), { ...context, unrelatedUiLabel: "changed" });
  assert.equal(revisionOptions.calculationFingerprint, originalFingerprint, "unrelated UI inputs leave calculation identity unchanged");
  vm.runInNewContext(source.slice(start, end), { ...context,
    companyHistoryObservationWithCurrentCapacity: function companyHistoryObservationWithCurrentCapacity() { return "changed projection"; } });
  assert.notEqual(revisionOptions.calculationFingerprint, originalFingerprint, "an inline projection code change invalidates saved calculations");
  vm.runInNewContext(source.slice(start, end), { ...context,
    manualCorrectionRoomSegmentTotal: function manualCorrectionRoomSegmentTotal() { return "changed transitive correction"; } });
  assert.notEqual(revisionOptions.calculationFingerprint, originalFingerprint, "a transitive room-correction helper change also invalidates saved calculations");
  const monthlyStart = source.indexOf("const readMonthlyReportRevision = createMonthlyReportSourceRevision({");
  const monthlyEnd = source.indexOf("\nconst analyticalMemory =", monthlyStart);
  let monthlyOptions;
  vm.runInNewContext(source.slice(monthlyStart, monthlyEnd), { ...context,
    createMonthlyReportSourceRevision: options => { monthlyOptions = options; return () => "monthly"; } });
  assert.equal(monthlyOptions.includeContext, false, "the existing monthly/industry reference scope stays independent");
});

test("the first app save after a restart does not requeue unchanged companies", async t => {
  const f = await fixture(t);
  await f.write(await f.read());
  await f.createWriter()(await f.read());
  assert.deepEqual(queued(f), [[], []]);
  assert.equal(f.events.filter(event => event.type === "bootstrap").length, 2, "company-list invalidation remains active");
  assert.deepEqual(f.events.filter(event => event.type === "industry").map(event => event.reason), ["company_saved", "company_saved"],
    "existing industry invalidation is preserved");
});

test("only the reviewed company is queued and the zero observation remains zero", async t => {
  const f = await fixture(t);
  const next = await f.read();
  next.companies.a.manualCorrection = { lodgingBasisTotal: 17, revision: 2 };
  next.companies.a.inventory = { latest: { productSnapshot: { daily: [{ sold: 0, publicRevenue: 0 }] } } };
  await f.write(next);
  assert.deepEqual(queued(f), [["a"]]);
  const stored = await f.read();
  assert.equal(stored.companies.a.manualCorrection.lodgingBasisTotal, 17);
  assert.equal(stored.companies.a.inventory.latest.productSnapshot.daily[0].sold, 0);
  assert.equal(stored.companies.a.inventory.latest.productSnapshot.daily[0].publicRevenue, 0);
  assert.ok(stored.updatedAt);
});

test("a changed correction revision queues that company even when room quantity is unchanged", async t => {
  const f = await fixture(t);
  const next = await f.read();
  next.companies.b.manualCorrection.revision = 2;
  await f.write(next);
  assert.deepEqual(queued(f), [["b"]]);
});

test("new collected companies are queued while unchanged existing companies are reused", async t => {
  const f = await fixture(t);
  const next = await f.read();
  next.companies.c = company("c", { runIds: ["new-run"], keywords: { one: { keyword: "경남글램핑" } } });
  await f.write(next);
  assert.deepEqual(queued(f), [["c"]]);
  assert.equal(f.events.at(-1).reason, "company_saved");
});

test("object property order and master timestamps do not count as a company change", async t => {
  const f = await fixture(t);
  const next = await f.read();
  const old = next.companies.a;
  next.companies.a = { manualCorrection: { ...old.manualCorrection }, primaryName: old.primaryName, companyId: old.companyId };
  next.updatedAt = "2026-10-17T00:00:00.000Z";
  await f.write(next);
  assert.deepEqual(queued(f), [[]]);
});

test("merges queue the changed active target and exclude the retired source", async t => {
  const f = await fixture(t);
  const next = await f.read();
  next.companies.a.mergedIntoCompanyId = "b";
  next.companies.b.duplicateNotes = [{ mergedCompanyId: "a" }];
  await f.write(next);
  assert.deepEqual(queued(f), [["b"]]);
  assert.equal((await f.read()).companies.a.mergedIntoCompanyId, "b");
});

test("a genuinely missing master initializes the new companies without an artificial prior state", async t => {
  const f = await fixture(t, null);
  await f.write({ companies: { a: company("a") } });
  assert.deepEqual(queued(f), [["a"]]);
});

test("unreadable prior master is not treated as empty or overwritten", async t => {
  const f = await fixture(t, "not valid JSON");
  await assert.rejects(() => f.write({ companies: { a: company("a") } }), error =>
    error.code === "COMPANY_INTEGRATION_SOURCE_UNAVAILABLE" && !error.message.includes("not valid JSON"));
  assert.equal(await fsp.readFile(f.file, "utf8"), "not valid JSON");
  assert.deepEqual(f.events, []);
});

test("invalid stored company structure is held without enqueueing or replacing prior data", async t => {
  const f = await fixture(t, { companies: [] });
  const before = await fsp.readFile(f.file, "utf8");
  await assert.rejects(() => f.write({ companies: { a: company("a") } }), { code: "COMPANY_INTEGRATION_SOURCE_UNAVAILABLE" });
  assert.equal(await fsp.readFile(f.file, "utf8"), before);
  assert.deepEqual(f.events, []);
});

test("a prior read error remains a safe failure rather than a whole-company queue", async t => {
  let mutations = 0;
  const f = await fixture(t, null, { fileSystem: {
    readFile: async () => { throw Object.assign(new Error("private filesystem detail"), { code: "EACCES" }); },
    mkdir: async () => { mutations++; }, writeFile: async () => { mutations++; }, rename: async () => { mutations++; }
  } });
  await assert.rejects(() => f.write({ companies: { a: company("a") } }), error =>
    error.code === "COMPANY_INTEGRATION_SOURCE_UNAVAILABLE" && !error.message.includes("private"));
  assert.equal(mutations, 0);
  assert.deepEqual(f.events, []);
});
