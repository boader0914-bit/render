"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8").replace(/\r\n/g, "\n");
const startup = source.slice(source.lastIndexOf("\nseedOutputsFromRepo()"));
assert.ok(startup.includes("server.listen(PORT, HOST"), "execute the real server readiness path");

function gate() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture({ seedError = false, companyPending = false, companyError = false, catalogPending = false, catalogError = false } = {}) {
  const coordination = gate(), selectors = gate(), entered = gate(), company = gate(), companyEntered = gate();
  const catalog = gate(), catalogEntered = gate();
  if (!companyPending) company.resolve({ cacheStatus: "saved", data: { totalCompanies: 535 }, json: Buffer.alloc(1), gzip: Buffer.alloc(1) });
  if (!catalogPending) catalog.resolve();
  const calls = [], warnings = [];
  let listener;
  const context = {
    Promise, Object, Number, Math, Date, PORT: 10000, HOST: "127.0.0.1",
    process: { env: {} }, console: { log() {}, error() {}, warn: (...args) => warnings.push(args) },
    seedOutputsFromRepo: async () => { calls.push("seed"); if (seedError) throw new Error("seed unavailable"); },
    collectorBrokerReady: coordination.promise,
    companyBootstrapStore: { get: async () => {
      calls.push("company-list");
      companyEntered.resolve();
      if (companyError) throw Object.assign(new Error("private company content"), { code: "COMPANY_BOOTSTRAP_INVALID_SOURCE" });
      return company.promise;
    } },
    collectionRotationScheduler: {
      status: async () => calls.push("coordination"),
      start: async () => calls.push("rotation")
    },
    monthlyReportSources: { options: async options => {
      calls.push(["selectors", options]); entered.resolve(); return selectors.promise;
    } },
    companyIntegratedCatalog: { prepare: async () => {
      calls.push("company-catalog"); catalogEntered.resolve();
      if (catalogError) throw Object.assign(new Error("private catalog content"), { code: "COMPANY_CATALOG_SOURCE_UNAVAILABLE" });
      return catalog.promise;
    }, status: () => ({ status: "reused", storage: "saved", companyCount: 535 }) },
    server: { listen: (port, host, callback) => { assert.equal(port, 10000); assert.equal(host, "127.0.0.1"); calls.push("listen"); listener = callback; } },
    companyIntegratedDb: { bootstrap: async () => calls.push("companies") },
    industryAnalysisService: { bootstrap: async () => calls.push("industry") },
    dailyKeywordCollectionScheduler: { start: async () => { calls.push("daily"); return { enabled: false }; } },
    keywordWorkerSchedulers: {},
    releaseCommittedCollectionPostprocess: async () => {},
    collectionPostprocessQueue: { start: async () => {} },
    tourismVisitorMonthlyScheduler: { start: () => { calls.push("tourism"); return { enabled: false }; } },
    tourismDemandStrengthBackfillScheduler: { start: () => { calls.push("backfill"); return { enabled: false }; } },
    masterDbDualWriteQueue: { mode: "off" },
    setInterval: () => ({ unref() {} })
  };
  const ready = vm.runInNewContext(startup, context);
  return { calls, warnings, ready, coordination, selectors, entered, company, companyEntered, catalog, catalogEntered, listen: () => listener() };
}

test("readiness prepares persisted selectors after coordination and before aggregate bootstraps", async () => {
  const f = fixture();
  await Promise.resolve();
  assert.deepEqual(f.calls, ["seed"]);
  f.coordination.resolve(); await f.entered.promise;
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), ["seed", "coordination", "company-list", ["selectors", { priority: "foreground" }]]);
  f.selectors.resolve({ selectorCache: { storage: "saved" } }); await f.ready;
  assert.equal(f.calls.at(-1), "listen");
  assert.ok(!f.calls.includes("companies") && !f.calls.includes("industry"));
  f.listen(); await Promise.resolve();
  for (const name of ["companies", "industry", "daily", "rotation", "tourism", "backfill"]) {
    assert.equal(f.calls.filter(call => call === name).length, 1, `${name} still starts once`);
  }
  assert.deepEqual(f.warnings, []);
});

test("failed selector preparation does not suppress the server or existing source verification", async () => {
  const f = fixture(); f.coordination.resolve(); await f.entered.promise;
  f.selectors.reject(Object.assign(new Error("private diagnostic must not be logged"), { code: "MONTHLY_SOURCE_REVISION_UNAVAILABLE" }));
  await f.ready; f.listen(); await Promise.resolve();
  assert.ok(f.calls.includes("listen") && f.calls.includes("companies") && f.calls.includes("industry"));
  assert.deepEqual(f.warnings, [["monthly_selector_prepare_failed", "MONTHLY_SOURCE_REVISION_UNAVAILABLE"]]);
});

test("seed fallback still prepares selectors and runs both existing aggregate bootstraps", async () => {
  const f = fixture({ seedError: true }); f.coordination.resolve(); await f.entered.promise;
  f.selectors.resolve({ selectorCache: { storage: "failed" } }); await f.ready; f.listen();
  assert.ok(f.calls.includes("companies") && f.calls.includes("industry"));
  assert.equal(f.warnings.length, 1);
});

test("company list preparation finishes before selector reads and large aggregate bootstraps", async () => {
  const f = fixture({ companyPending: true }); f.coordination.resolve(); await f.companyEntered.promise;
  assert.deepEqual(f.calls, ["seed", "coordination", "company-list"]);
  assert.ok(!f.calls.includes("listen") && !f.calls.includes("companies") && !f.calls.includes("industry"));
  f.company.resolve({ cacheStatus: "calculated", data: { totalCompanies: 535 }, json: Buffer.alloc(20), gzip: Buffer.alloc(5) });
  await f.entered.promise;
  f.selectors.resolve({ selectorCache: { storage: "saved" } }); await f.ready;
  assert.equal(f.calls.at(-1), "listen");
});

test("company preparation failure remains a safe diagnostic while normal API errors remain available", async () => {
  const f = fixture({ companyError: true }); f.coordination.resolve(); await f.entered.promise;
  f.selectors.resolve({ selectorCache: { storage: "saved" } }); await f.ready; f.listen(); await Promise.resolve();
  assert.ok(f.calls.includes("listen") && f.calls.includes("companies"));
  assert.deepEqual(f.warnings, [["company_bootstrap_prepare_failed", "COMPANY_BOOTSTRAP_INVALID_SOURCE"]]);
});

test("compact company metadata finishes before readiness and background source reconstruction", async () => {
  const f = fixture({ catalogPending: true }); f.coordination.resolve(); await f.entered.promise;
  f.selectors.resolve({ selectorCache: { storage: "saved" } }); await f.catalogEntered.promise;
  assert.equal(f.calls.at(-1), "company-catalog");
  assert.ok(!f.calls.includes("listen") && !f.calls.includes("companies") && !f.calls.includes("industry"));
  f.catalog.resolve(); await f.ready; f.listen(); await Promise.resolve();
  assert.ok(f.calls.indexOf("company-catalog") < f.calls.indexOf("listen"));
  assert.ok(f.calls.indexOf("listen") < f.calls.indexOf("companies"));
  assert.deepEqual(f.warnings, []);
});

test("failed compact metadata preparation exposes a safe diagnostic without disabling other APIs", async () => {
  const f = fixture({ catalogError: true }); f.coordination.resolve(); await f.entered.promise;
  f.selectors.resolve({ selectorCache: { storage: "saved" } }); await f.ready; f.listen();
  assert.ok(f.calls.includes("listen") && f.calls.includes("companies"));
  assert.deepEqual(f.warnings, [["company_integrated_catalog_prepare_failed", "COMPANY_CATALOG_SOURCE_UNAVAILABLE"]]);
});
