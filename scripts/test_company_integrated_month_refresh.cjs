"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createCompanyIntegratedDb } = require("./lib/company_integrated_db.cjs");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const copy = value => JSON.parse(JSON.stringify(value));
const ID = "cmp_place_refresh", OTHER = "cmp_place_other", MONTH = "2026-09";
const hash = text => crypto.createHash("sha256").update(text).digest("hex");

async function fixture(t, { autoStart = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "company-month-refresh-"));
  const scheduler = createAnalyticalWorkScheduler(), scheduling = [], reads = [];
  const state = { revision: 1, fail: false, beforeReturn: null };
  const company = { companyId: ID, primaryName: "검수 업체", capacity: 10, capacitySource: "db_review" };
  const sources = { companies: [company], runs: [{ id: "run", collectedAt: "2026-09-01T00:00:00Z", collectionQuality: { status: "complete" } }],
    observations: [{ companyId: ID, companyKey: ID, runId: "run", collectedAt: "2026-09-01T00:00:00Z", stayDate: "2026-09-03",
      productType: "lodging", inventoryEvidenceVersion: 4, supply: 10, sold: 0, publicBookings: 0, phoneBookings: 0,
      publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0, partial: false, missing: false, unknownUnavailable: 0,
      phoneMissingPriceBookings: 0, capacityBasis: { count: 10, source: "manual_review" } }], rankObservations: [] };
  const original = JSON.stringify(sources), raw = { companyId: ID, manualCorrection: { lodgingBasisTotal: 10, revision: 1 } };
  const service = createCompanyIntegratedDb({ dataDir: root, autoStart, now: () => new Date("2026-10-24T00:00:00Z"),
    runWork: (operation, options) => { scheduling.push(copy(options)); return scheduler.run(operation, options); },
    catalog: async () => ({ companies: [copy(company)], rawCompanies: new Map([[ID, copy(raw)]]), runs: copy(sources.runs) }),
    listTargets: async () => [{ companyId: ID, months: [MONTH, "2026-10"] }],
    readRevision: async () => hash(String(state.revision)),
    loadSources: async (request, options) => {
      reads.push({ month: request.month, priority: options.priority });
      if (state.fail) throw Object.assign(new Error("do not expose private paths"), { code: "RECOVERY_SOURCE_CHANGED" });
      const result = copy(sources);
      if (state.beforeReturn) await state.beforeReturn(request, result);
      return result;
    } });
  const directory = path.join(root, "company_integrated", hash(ID));
  const monthFile = path.join(directory, `${MONTH}.json`), queueFile = path.join(root, "company_integrated", "queue.json");
  const queue = async () => fs.readFile(queueFile, "utf8");
  t.after(async () => {
    await service.stop(); await scheduler.close();
    assert.equal(JSON.stringify(sources), original, "raw observations are unchanged");
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("company-month-refresh-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, directory, monthFile, queue, state, sources, reads, scheduling, service };
}

test("explicit monthly refresh persists the selected month without consuming or rewriting pending jobs", async t => {
  const f = await fixture(t);
  await f.service.queueCompany(ID, { months: [MONTH, "2026-10"], reason: "bootstrap" });
  await f.service.queueCompany(OTHER, { months: ["2026-08"], reason: "bootstrap" });
  const before = await f.queue(), result = await f.service.refreshMonth(ID, { month: MONTH });
  assert.equal(result.status, "ready"); assert.equal(result.snapshot.summary.lodging.sold, 0);
  assert.equal(result.snapshot.daily.find(row => row.date === "2026-09-03").lodging.sold, 0);
  assert.equal(result.snapshot.daily.find(row => row.date === "2026-09-04").lodging.sold, null, "missing dates are never zero-filled");
  assert.equal(await f.queue(), before, "both selected and other-month queues retain exact durable bytes");
  assert.deepEqual(f.reads, [{ month: MONTH, priority: "foreground" }, { month: "2026-08", priority: "foreground" }]);
  assert.deepEqual(f.scheduling, [{ priority: "foreground", kind: "company-month-repair" }]);
  const stored = JSON.parse(await fs.readFile(f.monthFile, "utf8"));
  assert.deepEqual(stored.snapshot, result.snapshot); assert.equal(stored.roomBasis.capacity, 10);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, "index.json"), "utf8")).months, [MONTH]);
  const firstBytes = await fs.readFile(f.monthFile, "utf8"), firstReads = f.reads.length;
  await f.service.refreshMonth(ID, { month: MONTH });
  assert.equal(f.reads.length, firstReads + 2, "explicit repair revalidates saved product SHA inputs even when a revision is reusable");
  assert.equal(await fs.readFile(f.monthFile, "utf8"), firstBytes, "unchanged verified results retain original bytes");
  assert.equal(await f.queue(), before);
});

test("a failing saved source or a mid-read revision change preserves the last valid month and all queued work", async t => {
  const f = await fixture(t); await f.service.refreshMonth(ID, { month: MONTH });
  await f.service.queueCompany(ID, { months: [MONTH, "2026-10"] });
  const before = await fs.readFile(f.monthFile, "utf8"), queue = await f.queue();
  f.state.fail = true;
  await assert.rejects(f.service.refreshMonth(ID, { month: MONTH }), { code: "RECOVERY_SOURCE_CHANGED" });
  assert.equal(await fs.readFile(f.monthFile, "utf8"), before); assert.equal(await f.queue(), queue);
  f.state.fail = false;
  f.state.beforeReturn = async request => { if (request.month === MONTH) f.state.revision++; };
  await assert.rejects(f.service.refreshMonth(ID, { month: MONTH }), { code: "COMPANY_INTEGRATION_SOURCE_CHANGED" });
  assert.equal(await fs.readFile(f.monthFile, "utf8"), before); assert.equal(await f.queue(), queue);
});

test("a selected foreground month leaves an already-processing multi-month job intact", async t => {
  const f = await fixture(t, { autoStart: true });
  let release, markEntered, once = true, duringRefresh;
  const entered = new Promise(resolve => { markEntered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.state.beforeReturn = async request => {
    if (request.month === "2026-08" && once) { once = false; markEntered(); await gate; }
    if (request.month === MONTH && !duringRefresh) duringRefresh = (await f.service.status()).jobs.find(job => job.companyId === ID);
  };
  await f.service.queueCompany(ID, { months: ["2026-08", "2026-10"], reason: "bootstrap" });
  await entered;
  const processing = (await f.service.status()).jobs.find(job => job.companyId === ID);
  assert.equal(processing.status, "processing");
  const refreshing = f.service.refreshMonth(ID, { month: MONTH });
  release();
  const result = await refreshing;
  assert.equal(result.status, "ready");
  assert.deepEqual(duringRefresh, processing, "the foreground repair does not steal the running generation or remaining months");
  await f.service.drain();
  for (const month of ["2026-08", MONTH, "2026-10"]) {
    const stored = JSON.parse(await fs.readFile(path.join(f.directory, `${month}.json`), "utf8"));
    assert.equal(stored.month, month);
  }
  assert.equal((await f.service.status()).jobs.find(job => job.companyId === ID).status, "idle");
});

test("a newer generation cannot be certified by a monthly repair already in progress", async t => {
  const f = await fixture(t); await f.service.refreshMonth(ID, { month: MONTH });
  await f.service.queueCompany(ID, { months: [MONTH, "2026-10"] });
  const before = await fs.readFile(f.monthFile, "utf8");
  let changed = false;
  f.state.beforeReturn = async request => {
    if (request.month === MONTH && !changed) { changed = true; await f.service.queueCompany(ID, { months: ["2026-11"], reason: "newer_source" }); }
  };
  await assert.rejects(f.service.refreshMonth(ID, { month: MONTH }), { code: "COMPANY_INTEGRATION_GENERATION_CHANGED" });
  assert.equal(await fs.readFile(f.monthFile, "utf8"), before);
  const job = (await f.service.status()).jobs.find(row => row.companyId === ID);
  assert.deepEqual(job.months, [MONTH, "2026-10", "2026-11"]); assert.equal(job.status, "queued");
});

test("a publication index failure cannot replace the last normal month", async t => {
  const f = await fixture(t); await f.service.refreshMonth(ID, { month: MONTH });
  const before = await fs.readFile(f.monthFile, "utf8"); f.state.revision++;
  f.state.beforeReturn = async (_request, source) => {
    source.observations[0].sold = source.observations[0].publicBookings = 1;
    source.observations[0].publicRevenue = source.observations[0].estimatedRevenue = 100000;
  };
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === path.join(f.directory, "index.json")) throw Object.assign(new Error("private write path"), { code: "EACCES" });
    return rename(from, to);
  };
  try { await assert.rejects(f.service.refreshMonth(ID, { month: MONTH }), { code: "EACCES" }); }
  finally { fs.rename = rename; }
  assert.equal(await fs.readFile(f.monthFile, "utf8"), before);
});

test("invalid or inactive explicit month requests read no source observations", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.refreshMonth(ID, { month: "2026-13" }), { code: "invalid_month" });
  await assert.rejects(f.service.refreshMonth(OTHER, { month: MONTH }), { code: "company_not_found" });
  assert.deepEqual(f.reads, []);
});
