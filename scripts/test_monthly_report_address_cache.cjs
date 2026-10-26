"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { createMonthlyReportService } = require("./lib/monthly_reports.cjs");
const request = { type: "company", targetId: "company-a", month: "2026-09", cutoffDate: "2026-09-30" };

test("actual address region survives monthly service restart while the manual analysis region stays unchanged", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-address-cache-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let revision = "source-1", address = "합성도 합성군 시험로 10", loads = 0;
  const seen = [];
  const loadSources = async () => {
    loads++;
    return { companies: [{ companyId: "company-a", primaryName: "합성 업체", regionKey: "r2", regionLabel: "수동 분석지역",
      addressBasis: { status: "ready", address, basis: "saved_company_address", regionKey: "r1", regionLabel: "합성 주소지역" } },
      { companyId: "other", primaryName: "다른 업체", regionKey: "r1", addressBasis: { status: "ready", address: "합성도 합성군 다른길 20", basis: "saved_company_address" } }],
    regions: [{ id: "r1", label: "합성 주소지역", level: "local" }, { id: "r2", label: "수동 분석지역", level: "local" }], runs: [], observations: [] };
  };
  const options = { dataDir, calculationVersion: "address-cache-test-v1", loadSources, readSourceRevision: async () => revision,
    now: () => new Date("2026-10-26T00:00:00Z"), readCatchmentContext: async (_request, roster) => {
      seen.push(structuredClone(roster)); return { schemaVersion: 1, networkAttempted: false, entries: [], warnings: [], status: "missing" };
    } };
  const initialReport = await createMonthlyReportService(options).preview(request);
  assert.equal(loads, 2);
  const first = structuredClone(seen.at(-1));
  assert.equal(initialReport.companies[0].regionKey, "r2"); assert.equal(initialReport.companies[0].regionLabel, "수동 분석지역");
  assert.equal(first.companies[0].regionKey, "r1"); assert.equal(first.companies[0].regionLabel, "합성 주소지역");
  const restartedReport = await createMonthlyReportService({ ...options, loadSources: async () => { throw Error("unchanged saved monthly aggregate should be reused"); } }).preview(request);
  assert.deepEqual(seen.at(-1), first);
  assert.equal(restartedReport.companies[0].regionKey, "r2"); assert.equal(restartedReport.companies[0].regionLabel, "수동 분석지역");
  assert.deepEqual(first.companies.map(c => [c.companyId, c.primaryName, c.addressBasis.address]), [["company-a", "합성 업체", address]]);
  revision = "source-2"; address = "합성도 합성군 새주소로 30";
  const changedReport = await createMonthlyReportService(options).preview(request);
  assert.equal(loads, 4); assert.equal(seen.at(-1).companies[0].addressBasis.address, address);
  assert.equal(seen.at(-1).companies[0].regionKey, "r1"); assert.equal(changedReport.companies[0].regionKey, "r2");
  assert.equal(first.companies[0].addressBasis.address, "합성도 합성군 시험로 10");
});
