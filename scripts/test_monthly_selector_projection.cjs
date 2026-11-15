"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const { execFileSync } = require("node:child_process"), { createRequire } = require("node:module");
const { createMonthlyReportSources, compactMonthlySelectorCompany } = require("./lib/monthly_report_sources.cjs");
const { createMonthlyReportSelectorRevision } = require("./lib/monthly_report_selector_revision.cjs");
const filename = path.join(__dirname, "lib/monthly_report_sources.cjs"), baseline = { exports: {} };
const code = execFileSync("git", ["show", "b313105:scripts/lib/monthly_report_sources.cjs"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
vm.runInNewContext(code, { module: baseline, exports: baseline.exports, require: createRequire(filename), __filename: filename, __dirname: path.dirname(filename),
  Buffer, process, console, setTimeout, clearTimeout, setImmediate, structuredClone }, { filename: "production-b313105-monthly-sources.cjs" });
const plain = value => JSON.parse(JSON.stringify(value));
const selection = value => { const { selectorCache, ...rest } = plain(value); return rest; };
const now = () => new Date("2026-11-15T00:00:00Z");
async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, "monthly-selector-thin-"));
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(root)), parent); assert.match(path.basename(root), /^monthly-selector-thin-/); await fs.rm(root, { recursive: true, force: true }); });
  const companyFile = path.join(root, "company_master/companies.json"), regionMasterFile = path.join(root, "regions.json"), historyFile = path.join(root, "history/observations.jsonl");
  await fs.mkdir(path.dirname(companyFile)); await fs.mkdir(path.dirname(historyFile));
  const units = [
    { regionKey: "province", name: "남도", fullName: "남도", aliases: ["남도"], level: "broad", active: true, selectable: true },
    { regionKey: "r1", name: "시험군", fullName: "남도 시험군", aliases: ["시험군", "겹침"], provinceRegionKey: "province", level: "local", active: true, selectable: true },
    { regionKey: "r2", name: "다른군", fullName: "북도 다른군", aliases: ["다른군", "겹침"], level: "local", active: true, selectable: true }
  ];
  const heavy = { rooms: Array.from({ length: 100 }, (_, index) => ({ name: "fixture_" + index, privateUnusedGraph: "x".repeat(8192) })),
    snapshots: Array.from({ length: 20 }, () => ({ productSnapshot: { daily: Array.from({ length: 31 }, (_, day) => ({ stayDate: "2026-10-" + String(day + 1).padStart(2, "0"), rawTotal: 16 })) } })) };
  const companies = {
    address: { companyId: "address", primaryName: "가상 주소 숙소", addresses: [{ address: "남도 시험군 시험로 10" }], inventory: heavy, roomPrices: { private: "excluded" } },
    override: { companyId: "override", primaryName: "가상 보정 숙소", addresses: ["남도 시험군 시험로 10"], manualCorrection: { active: true, regionOverride: "r2" }, inventory: heavy },
    inactive: { companyId: "inactive", primaryName: "가상 비활성 보정", addresses: ["남도 시험군 시험로 10"], manualCorrection: { active: false, regionOverride: "r2" } },
    unknownOverride: { companyId: "unknownOverride", addresses: ["남도 시험군 시험로 10"], manualCorrection: { active: true, regionOverride: "missing" } },
    fallback: { companyId: "fallback", regions: ["남도", "시험군"] },
    ambiguous: { companyId: "ambiguous", regions: ["겹침"] },
    unknown: { companyId: "unknown" },
    deleted: { companyId: "deleted", deletedAt: "2026-10-01T00:00:00Z" },
    merged: { companyId: "merged", mergedIntoCompanyId: "address" }
  };
  await fs.writeFile(companyFile, JSON.stringify({ companies })); await fs.writeFile(regionMasterFile, JSON.stringify({ units }));
  await fs.writeFile(historyFile, [{ stayDate: "2026-09-01" }, { stayDate: "2026-10-15" }].map(JSON.stringify).join("\n") + "\n");
  const runs = [{ id: "r1", keyword: "가상 글램핑", checkIn: "2026-10-15", checkOut: "2026-11-14" },
    { id: "r2", keyword: "업체 이름", searchMode: "company", checkIn: "2026-09-20", checkOut: "2026-09-21" }];
  const revision = createMonthlyReportSelectorRevision({ dataDir: root, regionMasterFile });
  return { root, companyFile, regionMasterFile, historyFile, companies, runs, options: { dataDir: root, regionMasterFile, now,
    readOptionsRevision: revision, listRuns: async () => plain(runs), prepareCompanies: () => assert.fail("selectors must not prepare room capacities") } };
}

test("cold thin selectors exactly match the production full-master output and persisted reopen", async t => {
  const f = await fixture(t), original = await fs.readFile(f.companyFile);
  const legacy = baseline.exports.createMonthlyReportSources({ ...f.options, selectorCacheVersion: "full-baseline" });
  const current = createMonthlyReportSources({ ...f.options, selectorCacheVersion: "thin-current" });
  const expected = selection(await legacy.options()), actual = await current.options();
  assert.deepEqual(selection(actual), expected);
  assert.equal(current.sourceReadMetrics().selectorProjectionReads, 1);
  assert.deepEqual(actual.companies.map(row => row.id), ["address", "override", "inactive", "unknownOverride", "fallback", "ambiguous", "unknown"]);
  assert.equal(actual.companies.find(row => row.id === "override").regionKey, "r2");
  assert.equal(actual.companies.find(row => row.id === "inactive").regionKey, "r1");
  assert.equal(actual.companies.find(row => row.id === "unknownOverride").regionKey, "");
  assert.equal(actual.companies.find(row => row.id === "ambiguous").regionKey, "");
  const restarted = createMonthlyReportSources({ ...f.options, selectorCacheVersion: "thin-current", listRuns: () => assert.fail("valid saved selector must not reconstruct a catalog") });
  const reopened = await restarted.options(); assert.deepEqual(selection(reopened), expected); assert.equal(reopened.selectorCache.status, "reused");
  assert.equal(restarted.sourceReadMetrics().catalogFullReads, 0);
  assert.deepEqual(await fs.readFile(f.companyFile), original, "no original normalization or rewrite");
});

test("projection drops every inventory/history graph before the next company and broad catalogs retain their evidence", async t => {
  const f = await fixture(t), compact = compactMonthlySelectorCompany(f.companies.address);
  assert.deepEqual(Object.keys(compact), ["companyId", "primaryName", "addresses"]);
  assert.equal(Object.hasOwn(compact, "inventory"), false); assert.equal(Object.hasOwn(compact, "roomPrices"), false);
  const current = createMonthlyReportSources(f.options); await current.options();
  const broad = createMonthlyReportSources({ ...f.options, prepareCompanies: async companies => companies });
  const full = await broad.targetCatalog();
  assert.deepEqual(full.rawCompanies.get("address").inventory, f.companies.address.inventory);
  assert.equal(broad.sourceReadMetrics().selectorProjectionReads, 0);
});

test("changed names, regions and history months invalidate the saved selector with the original revision pins", async t => {
  const f = await fixture(t), current = createMonthlyReportSources({ ...f.options, selectorCacheVersion: "thin-current" });
  await current.options(); f.companies.address.primaryName = "가상 변경 이름"; f.companies.address.addresses = ["북도 다른군 변경로 20"];
  await fs.writeFile(f.companyFile, JSON.stringify({ companies: f.companies }));
  await fs.appendFile(f.historyFile, JSON.stringify({ stayDate: "2026-08-01" }) + "\n");
  const updated = await current.options(); assert.equal(updated.selectorCache.status, "calculated");
  assert.equal(updated.companies.find(row => row.id === "address").label, "가상 변경 이름 · 북도 다른군"); assert.ok(updated.months.includes("2026-08"));
  assert.equal(current.sourceReadMetrics().selectorProjectionReads, 2);
});

test("a source revision changed during a thin build rejects mixed selectors and retains the last saved entry", async t => {
  const f = await fixture(t), current = createMonthlyReportSources({ ...f.options, selectorCacheVersion: "stable" });
  await current.options(); const directory = path.join(f.root, "monthly_reports/selector_cache"), names = await fs.readdir(directory), file = path.join(directory, names[0]), before = await fs.readFile(file);
  let checks = 0;
  const raced = createMonthlyReportSources({ ...f.options, selectorCacheVersion: "stable", readOptionsRevision: async () => ++checks === 1 ? "new-before" : "different-after" });
  await assert.rejects(raced.options(), { code: "MONTHLY_SOURCE_CHANGED" });
  assert.deepEqual(await fs.readFile(file), before);
});

test("missing master retains the existing empty-install semantics and malformed/truncated input never becomes an empty selector", async t => {
  const f = await fixture(t); await fs.unlink(f.companyFile);
  for (const create of [baseline.exports.createMonthlyReportSources, createMonthlyReportSources]) {
    const service = create({ ...f.options, readOptionsRevision: null }); assert.deepEqual(plain((await service.options()).companies), []);
  }
  for (const input of ['{"companies":{"bad":{"companyId":"bad"}}', '{"companies":{"bad":{}}}trailing', '{"companies":[]}']) {
    await fs.writeFile(f.companyFile, input); const service = createMonthlyReportSources({ ...f.options, readOptionsRevision: null });
    await assert.rejects(service.options(), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  }
});

test("an upstream company stream error remains a source failure after projection", async t => {
  const f = await fixture(t), { Readable } = require("node:stream"), original = native.createReadStream;
  native.createReadStream = (file, options) => file !== f.companyFile ? original(file, options) : new Readable({ read() {
    this.push('{"companies":{"first":{"companyId":"first"}},'); this.destroy(new Error("synthetic stream failed"));
  } });
  try { const service = createMonthlyReportSources({ ...f.options, readOptionsRevision: null }); await assert.rejects(service.options(), { code: "MONTHLY_SOURCE_UNAVAILABLE" }); }
  finally { native.createReadStream = original; }
});

test("verified history-index months remain the selector authority and index failures never become empty months", async t => {
  const f = await fixture(t); let calls = 0;
  await fs.appendFile(f.historyFile, JSON.stringify({ stayDate: "2026-06-01" }) + "\n");
  const source = createMonthlyReportSources({ ...f.options, readOptionsRevision: null,
    observationIndex: { listMonths: async () => { calls++; return ["2026-07"]; } } });
  const result = await source.options(); assert.equal(calls, 1); assert.ok(result.months.includes("2026-07"));
  assert.ok(!result.months.includes("2026-06"), "an indexed selector never opens an independent raw-history fallback");
  const error = Object.assign(new Error("synthetic index unavailable"), { code: "HISTORY_OBSERVATION_SOURCE_UNAVAILABLE" });
  for (const create of [baseline.exports.createMonthlyReportSources, createMonthlyReportSources]) {
    const service = create({ ...f.options, readOptionsRevision: null, observationIndex: { listMonths: async () => { throw error; } } });
    await assert.rejects(service.options(), observed => observed === error);
  }
});
