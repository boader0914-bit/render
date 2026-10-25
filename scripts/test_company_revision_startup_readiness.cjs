"use strict";

const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { test } = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8").replace(/\r\n/g, "\n");
const startup = source.slice(source.lastIndexOf("\nseedOutputsFromRepo()"));
assert.ok(startup.includes("server.listen(PORT, HOST"), "execute the actual readiness path without starting the app");
const gate = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };

function fixture({ failure = null, absent = false } = {}) {
  const entered = gate(), revision = gate(), calls = [], warnings = [], logs = [];
  let listen, owned = false;
  const reader = async () => { throw Error("preparation must not request a company/month calculation"); };
  reader.prepare = async () => {
    assert.equal(owned, true); calls.push("revision"); entered.resolve();
    if (failure) throw failure;
    await revision.promise;
    return { secret: "private prepared company graph must not be logged" };
  };
  const context = {
    Promise, Object, Number, Math, Date, Buffer, PORT: 10000, HOST: "127.0.0.1", process: { env: {} },
    console: { log: (...args) => logs.push(args), warn: (...args) => warnings.push(args), error() {} },
    seedOutputsFromRepo: async () => calls.push("seed"), collectorBrokerReady: Promise.resolve(),
    collectionRotationScheduler: { status: async () => calls.push("coordination"), start: async () => calls.push("rotation-start") },
    companyBootstrapStore: { get: async () => { calls.push("company-list"); return { cacheStatus: "saved", data: { totalCompanies: 1 }, json: Buffer.alloc(1), gzip: Buffer.alloc(1) }; } },
    monthlyReportSources: { options: async () => { calls.push("selectors"); return { selectorCache: { status: "reused", storage: "saved" } }; } },
    companyIntegratedCatalog: { prepare: async () => calls.push("catalog"), status: () => ({ status: "reused" }) },
    ...(absent ? {} : { readCompanyIntegratedRevision: reader }),
    runAnalyticalWork: async (operation, options) => {
      assert.deepEqual(JSON.parse(JSON.stringify(options)), { priority: "foreground", kind: "company-revision-prepare" });
      assert.equal(owned, false); owned = true; calls.push("revision-owner");
      try { return await operation(); } finally { owned = false; calls.push("revision-owner-released"); }
    },
    server: { listen(port, host, callback) { assert.equal(owned, false); calls.push("listen"); listen = callback; } },
    companyIntegratedDb: { bootstrap: async () => calls.push("company-background") },
    industryAnalysisService: { bootstrap: async () => calls.push("industry-background") },
    dailyKeywordCollectionScheduler: { start: async () => ({ enabled: false }) }, keywordWorkerSchedulers: {},
    releaseCommittedCollectionPostprocess: async () => {}, collectionPostprocessQueue: { start: async () => {} },
    tourismVisitorMonthlyScheduler: { start: () => ({ enabled: false }) }, tourismDemandStrengthBackfillScheduler: { start: () => ({ enabled: false }) },
    masterDbDualWriteQueue: { mode: "off" }, setInterval: () => ({ unref() {} }),
    runCrawler() { throw Error("startup revision preparation must not collect"); },
    loadSources() { throw Error("startup revision preparation must not calculate a month"); }
  };
  const ready = vm.runInNewContext(startup, context);
  return { calls, warnings, logs, entered, revision, ready, listen: () => listen() };
}

test("the verified revision index is warmed after compact readiness and before listen/background bootstraps", async () => {
  const f = fixture(); await f.entered.promise;
  assert.deepEqual(f.calls, ["seed", "coordination", "company-list", "selectors", "catalog", "revision-owner", "revision"]);
  assert.ok(!f.calls.includes("listen")); f.revision.resolve(); await f.ready;
  assert.deepEqual(f.calls.slice(-2), ["revision-owner-released", "listen"]);
  assert.ok(!f.calls.includes("company-background") && !f.calls.includes("industry-background"));
  f.listen(); await Promise.resolve();
  assert.equal(f.calls.filter(value => value === "company-background").length, 1);
  assert.equal(f.calls.filter(value => value === "industry-background").length, 1);
  assert.deepEqual(f.warnings, []); assert.doesNotMatch(JSON.stringify(f.logs), /private prepared|secret/);
});

for (const code of ["COMPANY_SOURCE_REVISION_INDEX_INVALID", "https://private.invalid/session-secret"]) test("preparation failure retains listen and normal verification with a safe diagnostic: " + (code.startsWith("COMPANY") ? "safe code" : "untrusted code"), async () => {
  const f = fixture({ failure: Object.assign(new Error("private company/source details"), { code }) }); await f.ready;
  assert.ok(f.calls.includes("listen")); assert.equal(f.calls.includes("company-background"), false);
  assert.deepEqual(f.warnings, [["company_integrated_revision_prepare_failed", code.startsWith("COMPANY") ? code : "unavailable"]]);
  f.listen(); await Promise.resolve(); assert.ok(f.calls.includes("company-background") && f.calls.includes("industry-background"));
  assert.doesNotMatch(JSON.stringify([...f.warnings, ...f.logs]), /private company|private\.invalid|session-secret/);
});

test("an unavailable optional prepare capability keeps the existing startup path", async () => {
  const f = fixture({ absent: true }); await f.ready;
  assert.ok(f.calls.includes("listen")); assert.ok(!f.calls.includes("revision-owner")); assert.deepEqual(f.warnings, []);
  f.listen(); await Promise.resolve(); assert.ok(f.calls.includes("company-background"));
});
