"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { compactCompanyInventory, aggregateFields } = require("./lib/company_bootstrap.cjs");
const { startCompanyBootstrapFixture } = require("./fixtures/company_bootstrap_api_harness.cjs");

function companyBusinessFields(company) {
  const result = { ...company, inventory: compactCompanyInventory(company.inventory) };
  delete result.detailLoaded;
  for (const key of Object.keys(result)) if (/History$/.test(key)) delete result[key];
  result.keywords = result.keywords.map(keyword => { const row = { ...keyword }; delete row.recentRuns; return row; });
  result.demandSignals = aggregateFields(result.demandSignals);
  return result;
}

async function main() {
  const f = await startCompanyBootstrapFixture();
  const masterFile = path.join(f.dataDir, "company_master", "companies.json");
  const original = await fs.readFile(masterFile);
  const historyFile = path.join(f.dataDir, "history", "observations.jsonl");
  const history = await fs.readFile(historyFile);
  try {
    assert.equal((await f.request("/api/company-master/bootstrap")).status, 401);
    assert.equal((await f.request("/api/company-master/bootstrap", { cookie: await f.login("bootstrap-member") })).status, 403);
    const cookie = await f.login();
    const started = performance.now();
    const bootstrap = await f.request("/api/company-master/bootstrap", { cookie });
    const elapsedMs = performance.now() - started;
    assert.equal(bootstrap.status, 200, bootstrap.text);
    assert.equal(bootstrap.data.representation, "bootstrap");
    assert.equal(bootstrap.data.totalCompanies, 25);
    assert.equal(bootstrap.response.headers.get("x-company-bootstrap-cache"), "memory", "startup prepares before health readiness");
    assert.equal(bootstrap.response.headers.get("content-encoding"), "gzip");
    assert.equal(bootstrap.response.headers.get("cache-control"), "no-store");
    assert.equal(bootstrap.response.headers.get("vary"), "Accept-Encoding");
    const plain = await f.request("/api/company-master/bootstrap", { cookie, headers: { "Accept-Encoding": "identity" } });
    assert.equal(plain.response.headers.get("content-encoding"), null);
    assert.deepEqual(plain.data, bootstrap.data);
    const fractional = await f.request("/api/company-master/bootstrap", { cookie, headers: { "Accept-Encoding": "gzip;q=0.5" } });
    assert.equal(fractional.response.headers.get("content-encoding"), "gzip");
    const summary = await f.request("/api/company-master/summary", { cookie });
    assert.equal(summary.status, 200);
    assert.equal(summary.data.representation, undefined, "legacy summary contract is retained");
    const originalById = new Map(summary.data.companies.map(company => [company.companyId, company]));
    for (const company of bootstrap.data.companies) {
      assert.equal(company.detailLoaded, false);
      assert.deepEqual(companyBusinessFields(company), companyBusinessFields(originalById.get(company.companyId)), company.companyId);
      assert.ok(company.inventory.latest._bootstrapFeatureText.includes("반려견"));
    }
    for (const key of ["totalCompanies", "sourceKeyCount", "duplicateCandidateCount", "collectionSourceCounts", "collectionRoutes", "b2bSearchCompanyCount", "updatedAt", "principle"]) {
      assert.deepEqual(bootstrap.data[key], summary.data[key], key);
    }
    assert.ok(Buffer.byteLength(bootstrap.text) < Buffer.byteLength(summary.text) * .6, "heavy evidence stays out of startup payload");
    assert.deepEqual(await fs.readFile(masterFile), original, "reads do not rewrite source companies");
    assert.deepEqual(await fs.readFile(historyFile), history, "reads do not rewrite raw observations");
    const selectedId = "cmp_place_bootstrap_0";
    const detail = await f.request("/api/company-master/detail?companyId=" + selectedId, { cookie });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.company.companyId, selectedId);
    assert.equal(detail.data.products.length, 16, "explicit selection still loads product detail");
    assert.ok(detail.data.daily.length > 0, "explicit selection still loads daily evidence");
    const artifact = process.env.COMPANY_BOOTSTRAP_TEST_ARTIFACT_DIR;
    if (artifact) {
      await fs.mkdir(artifact, { recursive: true });
      await fs.writeFile(path.join(artifact, "test-full-summary.json"), summary.text);
      await fs.writeFile(path.join(artifact, "test-bootstrap-summary.json"), bootstrap.text);
    }
    const changed = await f.request("/api/company-master/manual-correction", { cookie, method: "POST", body: { companyId: selectedId, lodgingBasisTotal: 18, expectedRevision: 7 } });
    assert.equal(changed.status, 200, changed.text.slice(0, 500));
    const refreshed = await f.request("/api/company-master/bootstrap", { cookie });
    assert.notEqual(refreshed.data.sourceRevision, bootstrap.data.sourceRevision);
    const corrected = refreshed.data.companies.find(company => company.companyId === selectedId);
    assert.equal(corrected.manualCorrection.lodgingBasisTotal, 18);
    assert.equal(corrected.manualCorrectionRevision, 8);
    assert.equal(corrected.inventory.latest.salesSignal.lodgingBasisTotal, 18);
    assert.equal(corrected.inventory.latest.revenue.lodging.revenue, null, "unavailable recalculation must not become zero or stale revenue");
    assert.deepEqual(await fs.readFile(historyFile), history);
    await fs.writeFile(masterFile, "{private-source-fragment");
    const failed = await f.request("/api/company-master/bootstrap", { cookie });
    assert.equal(failed.status, 500, "unreadable/corrupt data is not a successful empty database");
    assert.equal(failed.data.totalCompanies, undefined);
    assert.ok(!failed.text.includes("private-source-fragment"), "a parser error must not expose source contents");
    console.log(JSON.stringify({ check: "company_bootstrap_api", companies: 25, readinessMs: Math.round(f.readinessMs),
      bootstrapGetMs: Math.round(elapsedMs), fullJsonBytes: Buffer.byteLength(summary.text), bootstrapJsonBytes: Buffer.byteLength(bootstrap.text),
      bootstrapGzipBytes: Number(bootstrap.response.headers.get("content-length")),
      auth: "admin_only", scalarAggregateParity: true, correctionInvalidation: true, sourceReadPreservation: true, detailSelection: true }));
  } finally { await f.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
