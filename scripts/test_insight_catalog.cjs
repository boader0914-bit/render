"use strict";

// Temporary synthetic files only. No providers, server, source writes or
// operational accounts are used by this metadata/login read-model suite.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createInsightCatalog } = require("./lib/insight_catalog.cjs");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "insight-catalog-"));
  const masterFile = path.join(root, "company_master", "companies.json"), regionMasterFile = path.join(root, "regions.json");
  const capacityFile = path.join(root, "company_integrated", "capacity-bases.json"), cacheFile = path.join(root, "insight_catalog", "catalog.json");
  const company = { companyId: "company_a", primaryName: "수집 업체명", addresses: [{ address: "경상남도 산청군 산청읍 1" }],
    placeIds: ["123", "123"], regions: ["경남", "산청군"],
    manualCorrection: { active: true, lodgingBasisTotal: 16, facilityTags: ["수영장"], updatedAt: "2026-10-23T01:00:00Z", privateNote: "PRIVATE_CORRECTION" },
    adminProfile: { active: true, primaryName: "검수 업체명", address: "검수 주소", privateToken: "PRIVATE_ADMIN" },
    inventory: { latest: { collectedAt: "2026-10-22T05:00:00Z", token: "PRIVATE_INVENTORY", products: [{ customers: ["PRIVATE_CUSTOMER"] }] },
      snapshots: [{ token: "PRIVATE_SNAPSHOT" }] }, customers: ["PRIVATE_CUSTOMER"], secret: "PRIVATE_SECRET" };
  const master = { schemaVersion: 1, customerToken: "PRIVATE_ROOT", companies: { company_a: company } };
  const regions = { units: [
    { regionKey: "kr:48", regionId: "48", fullName: "경상남도", name: "경남", aliases: ["경상남도"], level: "broad", active: true, selectable: true },
    { regionKey: "kr:48860", regionId: "48860", fullName: "경상남도 산청군", name: "산청군", provinceRegionKey: "kr:48", aliases: ["경남 산청군"], level: "local", active: true, selectable: true },
    { regionKey: "kr:48840", regionId: "48840", fullName: "경상남도 남해군", name: "남해군", provinceRegionKey: "kr:48", level: "local", active: true, selectable: true },
    { regionKey: "kr:42820", regionId: "42820", fullName: "강원특별자치도 고성군", name: "고성군", level: "local", active: true, selectable: true },
    { regionKey: "kr:48820", regionId: "48820", fullName: "경상남도 고성군", name: "고성군", provinceRegionKey: "kr:48", level: "local", active: true, selectable: true }
  ] };
  const capacities = { schemaVersion: 1, companies: { company_a: { source: "observed_locked", count: 17, revision: 4, history: [{ count: 999 }] } } };
  const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); };
  await Promise.all([write(masterFile, master), write(regionMasterFile, regions), write(capacityFile, capacities)]);
  const reviewedCapacity = row => row.manualCorrection?.active === false ? null : row.manualCorrection?.lodgingBasisTotal || null;
  const make = overrides => createInsightCatalog({ dataDir: root, regionMasterFile, reviewedCapacity, ...overrides });
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("insight-catalog-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, masterFile, regionMasterFile, capacityFile, cacheFile, company, master, regions, capacities, write, make };
}

test("public metadata preserves current review, profile, exact region and observed timestamp without private inventories", async t => {
  const f = await fixture(t), cache = f.make(), value = await cache.catalog();
  assert.equal(value.companies[0].capacity, 16); assert.equal(value.companies[0].capacitySource, "관리자 검수값");
  assert.equal(value.companies[0].capacityBasis.source, "db_review"); assert.equal(value.companies[0].regionKey, "kr:48860");
  assert.deepEqual(value.companies[0].placeIds, ["123"]); assert.deepEqual(value.runs, []);
  assert.ok(value.rawCompanies instanceof Map);
  const raw = value.rawCompanies.get("company_a");
  assert.deepEqual(raw.adminProfile, { active: true, primaryName: "검수 업체명", address: "검수 주소" });
  assert.deepEqual(raw.inventory, { latest: { collectedAt: "2026-10-22T05:00:00Z" } });
  assert.deepEqual(raw.manualCorrection.facilityTags, ["수영장"]);
  assert.ok(!(await fs.readFile(f.cacheFile, "utf8")).includes("PRIVATE_"));
  assert.ok(!JSON.stringify([...value.rawCompanies]).includes("PRIVATE_"));
  assert.equal(cache.status().projectionReads, 1); assert.equal(cache.status().state, "calculated");
});

test("fresh three-file signatures reuse memory and protect returned values from consumer mutations", async t => {
  const f = await fixture(t), cache = f.make(), first = await cache.catalog(), checks = cache.status().sourceChecks;
  first.companies[0].capacity = 888; first.rawCompanies.get("company_a").manualCorrection.facilityTags.push("bad"); first.regions.length = 0;
  const next = await cache.catalog();
  assert.equal(next.companies[0].capacity, 16); assert.deepEqual(next.rawCompanies.get("company_a").manualCorrection.facilityTags, ["수영장"]);
  assert.equal(next.regions.length, 5); assert.equal(cache.status().projectionReads, 1);
  assert.ok(cache.status().sourceChecks >= checks + 2); assert.equal(cache.status().storage, "memory");
});

test("restart reuses checksummed persisted projection without opening company bodies or touching its file", async t => {
  const f = await fixture(t), expected = await f.make().prepare(), before = await fs.stat(f.cacheFile, { bigint: true });
  const fileSystem = { ...fs, open: async (file, ...args) => { assert.notEqual(file, f.masterFile, "master body must not be opened on a saved hit"); return fs.open(file, ...args); } };
  const cache = f.make({ fileSystem }), value = await cache.catalog();
  assert.deepEqual(value, expected); assert.equal(cache.status().projectionReads, 0); assert.equal(cache.status().storage, "saved");
  assert.equal((await fs.stat(f.cacheFile, { bigint: true })).mtimeNs, before.mtimeNs);
});

test("eight simultaneous cold reads share one projection and return independently owned maps", async t => {
  const f = await fixture(t), cache = f.make(), values = await Promise.all(Array.from({ length: 8 }, () => cache.catalog()));
  assert.equal(cache.status().projectionReads, 1); values[0].rawCompanies.delete("company_a"); values[0].companies[0].capacity = 100;
  for (const value of values.slice(1)) { assert.equal(value.rawCompanies.size, 1); assert.equal(value.companies[0].capacity, 16); }
});

test("DB room review changes are immediately reflected without capacity preparation or observed-data recalculation", async t => {
  const f = await fixture(t), cache = f.make(); await cache.catalog();
  f.company.manualCorrection.lodgingBasisTotal = 10; await f.write(f.masterFile, f.master);
  const next = await cache.catalog(); assert.equal(next.companies[0].capacity, 10); assert.equal(cache.status().projectionReads, 2);
  const unchangedBasis = JSON.parse(await fs.readFile(f.capacityFile, "utf8")); assert.equal(unchangedBasis.companies.company_a.count, 17);
});

test("only positive observed_locked bases are reused after review removal; old db_review never survives", async t => {
  const f = await fixture(t), cache = f.make(); await cache.catalog();
  delete f.company.manualCorrection.lodgingBasisTotal; await f.write(f.masterFile, f.master);
  let next = await cache.catalog(); assert.equal(next.companies[0].capacity, 17); assert.equal(next.companies[0].capacityBasis.source, "observed_locked");
  f.capacities.companies.company_a = { source: "db_review", count: 16 }; await f.write(f.capacityFile, f.capacities);
  next = await cache.catalog(); assert.equal(next.companies[0].capacity, null); assert.equal(next.companies[0].capacitySource, "객실 기준 확인 필요");
  f.capacities.companies.company_a = { source: "observed_locked", count: 0 }; await f.write(f.capacityFile, f.capacities);
  next = await cache.catalog(); assert.equal(next.companies[0].capacity, null);
});

test("missing optional capacity file is unknown and never copies stale observed room totals", async t => {
  const f = await fixture(t), cache = f.make(); delete f.company.manualCorrection.lodgingBasisTotal; await f.write(f.masterFile, f.master);
  assert.equal((await cache.catalog()).companies[0].capacity, 17);
  await fs.unlink(f.capacityFile);
  assert.equal((await cache.catalog()).companies[0].capacity, null);
  const restarted = f.make(); assert.equal((await restarted.catalog()).companies[0].capacity, null);
});

test("exact override wins, inactive override is ignored, and invalid explicit override remains unknown", async t => {
  const f = await fixture(t), cache = f.make(); f.company.manualCorrection.regionOverride = "kr:48840"; await f.write(f.masterFile, f.master);
  assert.equal((await cache.catalog()).companies[0].regionKey, "kr:48840");
  f.company.manualCorrection.regionOverride = "없는 지역"; await f.write(f.masterFile, f.master);
  assert.equal((await cache.catalog()).companies[0].regionKey, "");
  f.company.manualCorrection.active = false; await f.write(f.masterFile, f.master);
  assert.equal((await cache.catalog()).companies[0].regionKey, "kr:48860");
});

test("a truthy invalid legacy region override remains unknown without rejecting other company metadata", async t => {
  const f = await fixture(t), cache = f.make();
  for (const override of ["x".repeat(301), "kr:48860\u0001", "   ", { regionKey: "kr:48860" }, ["kr:48860"], true, 48860]) {
    f.company.manualCorrection.active = true; f.company.manualCorrection.regionOverride = override;
    await f.write(f.masterFile, f.master);
    const unknown = await cache.catalog();
    assert.equal(unknown.companies[0].regionKey, "", "an explicit invalid override must not fall back to the observed address");
    assert.equal(unknown.companies[0].capacity, 16, "unrelated reviewed metadata remains available");
    const projected = unknown.rawCompanies.get("company_a").manualCorrection;
    assert.equal(projected.regionOverride, ""); assert.equal(projected.regionOverrideInvalid, true);
    f.company.manualCorrection.active = false; await f.write(f.masterFile, f.master);
    assert.equal((await cache.catalog()).companies[0].regionKey, "kr:48860", "inactive overrides still leave the address mapping available");
  }
});

test("a new company in every selectable official local region resolves from its full address", async t => {
  const f = await fixture(t), official = JSON.parse(await fs.readFile(path.join(__dirname, "..", "web", "data", "region_master.json"), "utf8"));
  const local = official.units.filter(unit => unit.active && unit.selectable && unit.level === "local");
  assert.ok(local.length > 200, "exercise the full official local-region catalog");
  const companies = {}, expected = new Map();
  local.forEach((region, index) => {
    const companyId = "new_company_" + index; expected.set(companyId, region.regionKey);
    companies[companyId] = { companyId, primaryName: "합성 신규업체 " + index, addresses: [(region.fullName || region.name) + " 테스트길 1"], regions: [], manualCorrection: { active: true, lodgingBasisTotal: 16 } };
  });
  await f.write(f.masterFile, { schemaVersion: 1, companies }); await f.write(f.regionMasterFile, official);
  const value = await f.make().catalog(); assert.equal(value.companies.length, local.length);
  for (const company of value.companies) assert.equal(company.regionKey, expected.get(company.companyId));
});

test("same-name counties cannot be guessed; full address and exact local IDs remain unambiguous", async t => {
  const f = await fixture(t), cache = f.make(); f.company.addresses = ["고성군 모호한 주소"]; f.company.regions = ["고성군"]; await f.write(f.masterFile, f.master);
  assert.equal((await cache.catalog()).companies[0].regionKey, "");
  f.company.addresses = ["경상남도 고성군 회화면 1"]; await f.write(f.masterFile, f.master);
  assert.equal((await cache.catalog()).companies[0].regionKey, "kr:48820");
  f.company.addresses = []; f.company.regions = ["kr:48820", "kr:48"]; await f.write(f.masterFile, f.master);
  assert.equal((await cache.catalog()).companies[0].regionKey, "kr:48820");
});

test("region-master rename is fresh and longest matching address wins over a province alias", async t => {
  const f = await fixture(t), cache = f.make(); await cache.catalog();
  f.regions.units[1].fullName = "경상남도 산청군 새 표기"; f.regions.units[1].aliases = ["경상남도 산청군"]; await f.write(f.regionMasterFile, f.regions);
  const value = await cache.catalog(); assert.equal(value.companies[0].regionKey, "kr:48860"); assert.equal(value.companies[0].regionLabel, "경상남도 산청군 새 표기");
});

test("deleted and merged companies disappear instead of surviving in an older successful read", async t => {
  const f = await fixture(t), cache = f.make(); await cache.catalog();
  f.master.companies.company_b = { ...clone(f.company), companyId: "company_b", mergedIntoCompanyId: "company_a" };
  f.company.deletedAt = "2026-10-23"; await f.write(f.masterFile, f.master);
  const next = await cache.catalog(); assert.deepEqual(next.companies, []); assert.equal(next.rawCompanies.size, 0);
});

for (const target of ["master", "regions"]) test(`missing required ${target} fails closed even after a successful memory hit`, async t => {
  const f = await fixture(t), cache = f.make(); await cache.catalog(); await fs.unlink(target === "master" ? f.masterFile : f.regionMasterFile);
  await assert.rejects(cache.catalog(), error => error.statusCode === 503 && error.code === "INSIGHT_CATALOG_SOURCE_UNAVAILABLE");
  assert.equal(cache.status().state, "unavailable");
});

for (const target of ["master", "regions", "capacity"]) test(`corrupt ${target} fails closed instead of falling back to the last successful catalog`, async t => {
  const f = await fixture(t), cache = f.make(); await cache.catalog();
  await fs.writeFile(target === "master" ? f.masterFile : target === "regions" ? f.regionMasterFile : f.capacityFile, "{BROKEN");
  await assert.rejects(cache.catalog(), error => error.statusCode === 503); assert.equal(cache.status().state, "unavailable");
});

test("source read permission errors never expose an old successful projection or private error text", async t => {
  const f = await fixture(t); await f.make().catalog();
  const cache = f.make({ fileSystem: { ...fs, lstat: async (file, ...args) => {
    if (file === f.masterFile) throw Object.assign(new Error("PRIVATE_PATH_AND_TOKEN"), { code: "EACCES" }); return fs.lstat(file, ...args);
  } } });
  await assert.rejects(cache.catalog(), error => error.code === "INSIGHT_CATALOG_SOURCE_UNAVAILABLE" && !error.message.includes("PRIVATE_"));
});

test("a source changed during the first stream is retried and publishes only the second stable version", async t => {
  const f = await fixture(t); let changes = 0;
  const reviewedCapacity = row => { if (changes++ === 0) f.company.manualCorrection.lodgingBasisTotal = 9; return row.manualCorrection.lodgingBasisTotal; };
  let opened = 0;
  const fileSystem = { ...fs, open: async (file, ...args) => {
    const handle = await fs.open(file, ...args);
    if (file !== f.masterFile) return handle;
    opened++;
    const originalStat = handle.stat.bind(handle); let statCalls = 0;
    handle.stat = async (...statArgs) => { if (++statCalls === 2 && opened === 1) await f.write(f.masterFile, f.master); return originalStat(...statArgs); };
    return handle;
  } };
  const cache = f.make({ reviewedCapacity, fileSystem }), next = await cache.catalog();
  assert.equal(next.companies[0].capacity, 9); assert.equal(cache.status().projectionReads, 2);
});

test("two consecutive source changes fail closed without publishing either unstable projection", async t => {
  const f = await fixture(t); let count = 0;
  const fileSystem = { ...fs, open: async (file, ...args) => {
    const handle = await fs.open(file, ...args); if (file !== f.masterFile) return handle;
    const originalStat = handle.stat.bind(handle); let statCalls = 0;
    handle.stat = async (...statArgs) => { if (++statCalls === 2) { f.company.primaryName = "변경 " + ++count; await f.write(f.masterFile, f.master); } return originalStat(...statArgs); };
    return handle;
  } };
  const cache = f.make({ fileSystem }); await assert.rejects(cache.catalog(), error => error.code === "INSIGHT_CATALOG_SOURCE_CHANGED");
  assert.equal(cache.status().projectionReads, 2); await assert.rejects(fs.access(f.cacheFile), { code: "ENOENT" });
});

test("same-size inode replacement and ctime-only master edits invalidate a saved projection", async t => {
  const f = await fixture(t), cache = f.make(); await cache.catalog();
  const before = await fs.stat(f.masterFile); f.company.manualCorrection.lodgingBasisTotal = 15;
  const replacement = f.masterFile + ".replace"; await f.write(replacement, f.master); await fs.utimes(replacement, before.atime, before.mtime); await fs.rename(replacement, f.masterFile);
  assert.equal((await cache.catalog()).companies[0].capacity, 15);
  const sameInode = await fs.stat(f.masterFile); f.company.manualCorrection.lodgingBasisTotal = 14; await f.write(f.masterFile, f.master); await fs.utimes(f.masterFile, sameInode.atime, sameInode.mtime);
  assert.equal((await cache.catalog()).companies[0].capacity, 14);
});

test("corrupt persisted checksums and versions rebuild from current public sources", async t => {
  const f = await fixture(t); await f.make().catalog();
  let entry = JSON.parse(await fs.readFile(f.cacheFile, "utf8")); entry.value.companies[0].capacity = 999; await f.write(f.cacheFile, entry);
  let cache = f.make(); assert.equal((await cache.catalog()).companies[0].capacity, 16); assert.equal(cache.status().projectionReads, 1);
  entry = JSON.parse(await fs.readFile(f.cacheFile, "utf8")); entry.version = "old-version";
  const { checksum: _ignored, ...body } = entry; entry.checksum = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"); await f.write(f.cacheFile, entry);
  cache = f.make(); assert.equal((await cache.catalog()).companies[0].capacity, 16); assert.equal(cache.status().projectionReads, 1);
});

test("a long analytical lease cannot block a cold or warm Insight metadata read", async t => {
  const f = await fixture(t), hold = deferred(), started = deferred();
  const scheduler = createAnalyticalWorkScheduler();
  const busy = scheduler.run(async () => { started.resolve(); await hold.promise; }, { kind: "test-long-analysis" });
  await started.promise;
  try {
    const cache = f.make(), deadline = deferred(); const timer = setTimeout(() => deadline.resolve("timed-out"), 1500);
    try { const result = await Promise.race([cache.catalog(), deadline.promise]); assert.notEqual(result, "timed-out"); assert.equal(result.companies[0].capacity, 16); }
    finally { clearTimeout(timer); }
    assert.equal((await cache.catalog()).companies[0].capacity, 16);
  } finally { hold.resolve(); await busy; }
});
