"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { registeredMarketTargets } = require("./lib/regional_market_targets.cjs");
const { createCatchmentAddressDirectory } = require("./lib/catchment_address_directory.cjs");
const PROVINCE = "kr_admin_4800000000", JINJU = "kr_gyeongnam_jinju", SANCHEONG = "kr_gyeongnam_sancheong";
const units = [
  { regionKey: PROVINCE, regionId: PROVINCE, name: "경상남도", fullName: "경상남도", aliases: ["경남"], active: true, selectable: true, level: "broad" },
  { regionKey: JINJU, regionId: "kr_admin_4817000000", provinceRegionKey: PROVINCE, name: "진주시", fullName: "경상남도 진주시", aliases: ["진주", "경남 진주"], active: true, selectable: true, level: "local", unitType: "city" },
  { regionKey: SANCHEONG, regionId: "kr_admin_4886000000", provinceRegionKey: PROVINCE, name: "산청군", fullName: "경상남도 산청군", aliases: ["산청", "경남 산청"], active: true, selectable: true, level: "local", unitType: "county" },
  { regionKey: "gyeonggi_gwangju", regionId: "kr_admin_4161000000", name: "광주시", fullName: "경기도 광주시", aliases: ["광주"], active: true, selectable: true, level: "local", unitType: "city" },
  { regionKey: "gwangju_broad", regionId: "kr_admin_2900000000", name: "광주시", fullName: "광주광역시", aliases: ["광주"], active: true, selectable: true, level: "broad" }
];
const projected = (regions = [], addresses = [], extra = {}) => ({ companyId: "fixture_company", addresses, regionBasis: { regions, override: "", invalid: false }, ...extra });
const targets = values => registeredMarketTargets(values, units);
async function fixture(t, companies) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "regional-targets-test-")), file = path.join(folder, "companies.json");
  t.after(async () => { const resolved = path.resolve(folder); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("regional-targets-test-")); await fs.rm(resolved, { recursive: true, force: true }); });
  await fs.writeFile(file, JSON.stringify({ companies: Object.fromEntries(companies.map(company => [company.companyId, company])) }));
  return { file, folder };
}

test("public province-qualified addresses select the actual local region without coordinates or keyword inference", () => {
  assert.deepEqual(targets([projected([], ["경상남도 진주시 진주대로 123"]), projected([], ["경남 산청 산청읍 시험로 12"])]), [JINJU, SANCHEONG]);
  assert.deepEqual(targets([projected([], ["진주 시험로 12"]), projected(["진주글램핑"]), projected(["진주 근처"])]), ["", "", ""]);
});

test("saved canonical keys, exact region IDs, names and normalized exact aliases resolve consistently", () => {
  assert.deepEqual(targets([projected([JINJU]), projected(["kr_admin_4817000000"]), projected(["진주시"]), projected([" 진 주 "])]), [JINJU, JINJU, JINJU, JINJU]);
  assert.deepEqual(targets([projected(["진주", "진주시", JINJU])]), [JINJU]);
});

test("address evidence takes precedence over non-override saved region metadata", () => {
  assert.deepEqual(targets([projected([SANCHEONG], ["경상남도 진주시 시험로 12"])]), [JINJU]);
});

test("one local region plus its explicitly recorded parent is usable but conflicting local regions are held", () => {
  assert.deepEqual(targets([projected(["경남", "진주"]), projected(["진주", "산청"]), projected(["진주", "광주광역시"])]), [JINJU, "", ""]);
});

test("unresolved or ambiguous saved region members cannot be discarded to promote another match", () => {
  assert.deepEqual(targets([projected(["진주", "존재하지않는지역"]), projected(["진주", "광주시"]), projected(["광주"])]), ["", "", ""]);
});

test("conflicting or partly unresolved public addresses remain unknown without a regional fallback", () => {
  assert.deepEqual(targets([projected(["진주"], ["경상남도 진주시 시험로 12", "해석불가 주소 99"]),
    projected(["진주"], ["경상남도 진주시 시험로 12", "경상남도 산청군 시험로 12"])]), ["", ""]);
});

test("an explicit valid override is authoritative while invalid and ambiguous overrides hold the company", () => {
  assert.deepEqual(targets([projected(["산청"], ["경상남도 진주시 시험로 12"], { regionBasis: { regions: ["산청"], override: "산청", invalid: false } }),
    projected(["산청"], ["경상남도 진주시 시험로 12"], { regionBasis: { regions: ["산청"], override: "광주시", invalid: false } }),
    projected(["산청"], ["경상남도 진주시 시험로 12"], { regionBasis: { regions: ["산청"], override: "진주", invalid: true } })]), [SANCHEONG, "", ""]);
});

test("inactive and unselectable master units never become targets", () => {
  assert.deepEqual(registeredMarketTargets([projected(["진주"]), projected(["산청"])], units.map(unit => ({ ...unit, ...(unit.regionKey === JINJU ? { active: false } : unit.regionKey === SANCHEONG ? { selectable: false } : {}) }))), ["", ""]);
});

test("target selection is bounded, detached and does not mutate source rows or the region master", () => {
  const companies = [projected(["진주"], [])], before = JSON.stringify({ companies, units });
  const selected = targets(companies); selected[0] = "changed"; assert.equal(JSON.stringify({ companies, units }), before);
  assert.throws(() => targets(new Array(4097).fill(projected(["진주"]))), /TARGET_READ_FAILED/);
  assert.throws(() => registeredMarketTargets({}, units), /TARGET_READ_FAILED/); assert.throws(() => registeredMarketTargets([], {}), /TARGET_READ_FAILED/);
});

test("region metadata is opt-in and the existing default address projection contract remains identical", async t => {
  const f = await fixture(t, [{ companyId: "fixture_a", primaryName: "fixture", addresses: ["경상남도 진주시 시험로 12"], regions: ["진주"], keywords: { unrelated: "do-not-project" }, inventory: { private: "do-not-project" } }]);
  const before = await fs.readFile(f.file), defaultRows = await createCatchmentAddressDirectory({ file: f.file, dataDir: f.folder }).read();
  assert.deepEqual(Object.keys(defaultRows[0]).sort(), ["addressBasis", "addresses", "companyId", "label"]);
  const directory = createCatchmentAddressDirectory({ file: f.file, dataDir: f.folder, includeRegionBasis: true }), rows = await directory.read();
  assert.deepEqual(rows[0].regionBasis, { regions: ["진주"], invalid: false, override: "" });
  assert.deepEqual(targets(rows), [JINJU]); assert.equal(JSON.stringify(rows).includes("do-not-project"), false);
  rows[0].regionBasis.regions.push("산청"); assert.deepEqual((await directory.read())[0].regionBasis.regions, ["진주"]);
  assert.deepEqual(await fs.readFile(f.file), before);
});

test("active manual overrides survive projection but inactive corrections cannot override public addresses", async t => {
  const base = { primaryName: "fixture", addresses: ["경상남도 진주시 시험로 12"], regions: ["진주"] };
  const f = await fixture(t, [{ ...base, companyId: "active", manualCorrection: { active: true, regionOverride: "산청" } },
    { ...base, companyId: "inactive", manualCorrection: { active: false, regionOverride: "산청", regionOverrideInvalid: true } }]);
  const rows = await createCatchmentAddressDirectory({ file: f.file, includeRegionBasis: true }).read();
  assert.deepEqual(targets(rows), [SANCHEONG, JINJU]);
});

test("malformed, oversized, control-character and explicitly invalid region metadata is held", async t => {
  const base = { addresses: ["경상남도 진주시 시험로 12"] };
  const f = await fixture(t, [{ ...base, companyId: "malformed", regions: "진주" }, { ...base, companyId: "too_many", regions: new Array(31).fill("진주") },
    { ...base, companyId: "control", regions: ["진주\u0000"] }, { ...base, companyId: "override_control", regions: ["진주"], manualCorrection: { regionOverride: "진주\u0000" } },
    { ...base, companyId: "invalid_override", regions: ["진주"], manualCorrection: { regionOverride: "진주", regionOverrideInvalid: true } }]);
  const rows = await createCatchmentAddressDirectory({ file: f.file, includeRegionBasis: true }).read();
  assert.ok(rows.every(row => row.regionBasis.invalid)); assert.deepEqual(targets(rows), ["", "", "", "", ""]);
});

test("deleted and merged companies are excluded before regional target inventory", async t => {
  const f = await fixture(t, [{ companyId: "kept", regions: ["진주"] }, { companyId: "deleted", regions: ["산청"], deletedAt: "2026-10-25" },
    { companyId: "merged", regions: ["산청"], mergedIntoCompanyId: "kept" }]);
  const rows = await createCatchmentAddressDirectory({ file: f.file, includeRegionBasis: true }).read(); assert.equal(rows.length, 1); assert.deepEqual(targets(rows), [JINJU]);
});
