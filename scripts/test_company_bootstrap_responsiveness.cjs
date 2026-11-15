"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { createCompanyIntegratedDb } = require("./lib/company_integrated_db.cjs");

test("startup metadata validation services health sockets before the company batch finishes", async t => {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, "company-bootstrap-responsive-"));
  let capacityReads = 0, healthDuringBatch = null, health;
  const total = 40, server = http.createServer((req, res) => { healthDuringBatch = capacityReads < total; res.end("ok"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const companies = Array.from({ length: total }, (_, index) => ({ companyId: "fixture_" + index,
    get capacity() { capacityReads++; const until = performance.now() + 2; while (performance.now() < until) {} return 10; } }));
  const revision = async () => "verified-source"; revision.prepare = async () => ({ revision: "verified-source" }); revision.forScope = async () => "verified-source";
  const store = createCompanyIntegratedDb({ dataDir: directory, autoStart: false, now: () => new Date("2026-11-15T00:00:00Z"),
    loadSources: async () => { throw Error("bootstrap must not calculate a month"); }, listTargets: async () => [], readRevision: revision,
    catalog: async () => {
      health = new Promise((resolve, reject) => http.get(`http://127.0.0.1:${server.address().port}/api/health`, response => {
        response.resume(); response.once("end", () => resolve(response.statusCode));
      }).once("error", reject));
      return { companies, rawCompanies: new Map() };
    } });
  t.after(async () => { await store.stop(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(await fs.realpath(directory)), parent); assert.match(path.basename(directory), /^company-bootstrap-responsive-/); await fs.rm(directory, { recursive: true, force: true }); });
  const result = await store.bootstrap(); assert.equal(await health, 200);
  assert.equal(healthDuringBatch, true, "an HTTP health request must not wait for the entire metadata batch");
  assert.equal(capacityReads, total); assert.equal(result.queued, 0); assert.equal(result.reused, 0);
});

test("a failed checkpoint cannot certify bootstrap or calculate replacement source rows", async t => {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, "company-bootstrap-responsive-fail-"));
  const revision = async () => "verified-source"; revision.prepare = async () => ({ revision: "verified-source" }); revision.forScope = async () => "verified-source";
  const store = createCompanyIntegratedDb({ dataDir: directory, autoStart: false, listTargets: async () => [{ companyId: "fixture", months: ["2026-09"] }],
    readRevision: revision, catalog: async () => ({ companies: [], rawCompanies: new Map() }),
    loadSources: async () => { throw Error("original rows must remain untouched"); },
    bootstrapCheckpoint: async () => { throw Object.assign(new Error("private input path"), { code: "BOOTSTRAP_CHECKPOINT_FAILED" }); } });
  t.after(async () => { await store.stop(); assert.equal(path.dirname(await fs.realpath(directory)), parent); await fs.rm(directory, { recursive: true, force: true }); });
  await assert.rejects(store.bootstrap(), { code: "BOOTSTRAP_CHECKPOINT_FAILED" });
  const state = JSON.parse(await fs.readFile(path.join(directory, "company_integrated", "queue.json"), "utf8"));
  assert.equal(state.bootstrap.status, "failed"); assert.equal(state.bootstrap.errorCode, "BOOTSTRAP_CHECKPOINT_FAILED");
  assert.equal(Object.keys(state.jobs).length, 0); assert.doesNotMatch(JSON.stringify(state), /private input/);
});
