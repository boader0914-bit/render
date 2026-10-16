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

function fixture({ seedError = false } = {}) {
  const coordination = gate(), selectors = gate(), entered = gate();
  const calls = [], warnings = [];
  let listener;
  const context = {
    Promise, Object, Number, Math, Date, PORT: 10000, HOST: "127.0.0.1",
    process: { env: {} }, console: { log() {}, error() {}, warn: (...args) => warnings.push(args) },
    seedOutputsFromRepo: async () => { calls.push("seed"); if (seedError) throw new Error("seed unavailable"); },
    collectorBrokerReady: coordination.promise,
    collectionRotationScheduler: {
      status: async () => calls.push("coordination"),
      start: async () => calls.push("rotation")
    },
    monthlyReportSources: { options: async options => {
      calls.push(["selectors", options]); entered.resolve(); return selectors.promise;
    } },
    server: { listen: (port, host, callback) => { assert.equal(port, 10000); assert.equal(host, "127.0.0.1"); calls.push("listen"); listener = callback; } },
    companyIntegratedDb: { bootstrap: async () => calls.push("companies") },
    industryAnalysisService: { bootstrap: async () => calls.push("industry") },
    dailyKeywordCollectionScheduler: { start: async () => { calls.push("daily"); return { enabled: false }; } },
    keywordWorkerSchedulers: {},
    tourismVisitorMonthlyScheduler: { start: () => { calls.push("tourism"); return { enabled: false }; } },
    tourismDemandStrengthBackfillScheduler: { start: () => { calls.push("backfill"); return { enabled: false }; } },
    masterDbDualWriteQueue: { mode: "off" },
    setInterval: () => ({ unref() {} })
  };
  const ready = vm.runInNewContext(startup, context);
  return { calls, warnings, ready, coordination, selectors, entered, listen: () => listener() };
}

test("readiness prepares persisted selectors after coordination and before aggregate bootstraps", async () => {
  const f = fixture();
  await Promise.resolve();
  assert.deepEqual(f.calls, ["seed"]);
  f.coordination.resolve(); await f.entered.promise;
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), ["seed", "coordination", ["selectors", { priority: "foreground" }]]);
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
