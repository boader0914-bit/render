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
  const state = { revision: 1, revisionFail: false, revisionCalls: 0, beforeRevision: null, fail: false, beforeReturn: null };
  const company = { companyId: ID, primaryName: "검수 업체", capacity: 10, capacitySource: "db_review" };
  const sources = { companies: [company], runs: [{ id: "run", collectedAt: "2026-09-01T00:00:00Z", collectionQuality: { status: "complete" } }],
    observations: [{ companyId: ID, companyKey: ID, runId: "run", collectedAt: "2026-09-01T00:00:00Z", stayDate: "2026-09-03",
      productType: "lodging", inventoryEvidenceVersion: 4, supply: 10, sold: 0, publicBookings: 0, phoneBookings: 0,
      publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0, partial: false, missing: false, unknownUnavailable: 0,
      phoneMissingPriceBookings: 0, capacityBasis: { count: 10, source: "manual_review" } }], rankObservations: [] };
  const original = JSON.stringify(sources), raw = { companyId: ID, manualCorrection: { lodgingBasisTotal: 10, revision: 1 } };
  const options = { dataDir: root, autoStart, now: () => new Date("2026-10-24T00:00:00Z"),
    runWork: (operation, options) => { scheduling.push(copy(options)); return scheduler.run(operation, options); },
    catalog: async () => ({ companies: [copy(company)], rawCompanies: new Map([[ID, copy(raw)]]), runs: copy(sources.runs) }),
    listTargets: async () => [{ companyId: ID, months: [MONTH, "2026-10"] }],
    readRevision: async () => { state.revisionCalls++;if(state.beforeRevision)await state.beforeRevision();if(state.revisionFail)throw Error("private revision failure");return hash(String(state.revision)); },
    loadSources: async (request, options) => {
      reads.push({ month: request.month, priority: options.priority });
      if (state.fail) throw Object.assign(new Error("do not expose private paths"), { code: "RECOVERY_SOURCE_CHANGED" });
      const result = copy(sources);
      if (state.beforeReturn) await state.beforeReturn(request, result);
      return result;
    } };
  const service = createCompanyIntegratedDb(options);
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
  return { root, directory, monthFile, queue, state, sources, raw, reads, scheduling, service, options };
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
  const pending = await f.service.status(), view = await f.service.get(ID,{month:MONTH});
  assert.equal(view.status,"ready");assert.equal(view.freshness.selectedMonthVerified,true);assert.equal(view.freshness.refreshStatus,"queued");
  assert.deepEqual(await f.service.status(),pending,"successful month reads never drain or reprioritize pending work");
  assert.equal(await f.queue(),before);
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

test("a selected-month certificate survives restart without certifying another pending month", async t => {
  const f=await fixture(t);await f.service.queueCompany(ID,{months:[MONTH,"2026-10"]});await f.service.refreshMonth(ID,{month:MONTH});
  const original=await fs.readFile(f.monthFile,"utf8"),proofFile=path.join(f.directory,`${MONTH}.refresh-proof.json`),proof=JSON.parse(await fs.readFile(proofFile,"utf8"));
  assert.equal(proof.kind,"verified_company_month_refresh");assert.equal(proof.generation,(await f.service.status()).jobs[0].generation);
  await f.service.stop();const restarted=createCompanyIntegratedDb(f.options);
  try{
    const view=await restarted.get(ID,{month:MONTH});assert.equal(view.status,"ready");assert.equal(view.freshness.selectedMonthVerified,true);
    assert.equal(view.freshness.refreshStatus,"queued");assert.equal((await restarted.get(ID,{month:"2026-10"})).status,"refreshing");
    assert.equal(await fs.readFile(f.monthFile,"utf8"),original);assert.equal((await restarted.status()).jobs[0].generation,proof.generation);
  }finally{await restarted.stop();}
});

test("a new queue generation invalidates a prior successful repair immediately and keeps every pending month", async t=>{
  const f=await fixture(t);await f.service.queueCompany(ID,{months:[MONTH,"2026-10"]});await f.service.refreshMonth(ID,{month:MONTH});
  const original=await fs.readFile(f.monthFile,"utf8"),proof=await fs.readFile(path.join(f.directory,`${MONTH}.refresh-proof.json`),"utf8");
  await f.service.queueCompany(ID,{months:["2026-11"],reason:"new_observation"});const queue=await f.queue(),reads=f.reads.length;
  assert.equal((await f.service.get(ID,{month:MONTH})).status,"refreshing");assert.equal(f.reads.length,reads);
  assert.equal(await fs.readFile(path.join(f.directory,`${MONTH}.refresh-proof.json`),"utf8"),proof);assert.equal(await fs.readFile(f.monthFile,"utf8"),original);
  assert.equal(await f.queue(),queue);assert.deepEqual((await f.service.status()).jobs[0].months,[MONTH,"2026-10","2026-11"]);
});

test("source and capacity dependency changes invalidate only the selected proof and never load raw observations on get", async t=>{
  const f=await fixture(t);await f.service.queueCompany(ID,{months:[MONTH,"2026-10"]});await f.service.refreshMonth(ID,{month:MONTH});
  const queue=await f.queue(),reads=f.reads.length;
  f.state.revision++;assert.equal((await f.service.get(ID,{month:MONTH})).status,"refreshing");
  f.state.revision--;assert.equal((await f.service.get(ID,{month:MONTH})).status,"ready");
  f.raw.manualCorrection.revision++;assert.equal((await f.service.get(ID,{month:MONTH})).status,"refreshing");
  f.raw.manualCorrection.revision--;assert.equal((await f.service.get(ID,{month:MONTH})).status,"ready");
  assert.equal(f.reads.length,reads);assert.equal(await f.queue(),queue);
});

test("tampered, old and wrong-scope certificates cannot certify a pending company month", async t=>{
  const f=await fixture(t);await f.service.queueCompany(ID,{months:[MONTH,"2026-10"]});await f.service.refreshMonth(ID,{month:MONTH});
  const proofFile=path.join(f.directory,`${MONTH}.refresh-proof.json`),original=await fs.readFile(proofFile,"utf8"),proof=JSON.parse(original);
  const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
  const rehash=value=>{delete value.proofDigest;return {...value,proofDigest:hash(JSON.stringify(stable(value)))};};
  for(const [key,value] of [["kind","unchanged_company_month_inputs"],["companyId",OTHER],["month","2026-10"],["calculationVersion","old_math"],["generation",proof.generation-1],["bootstrapFailureGeneration",99],["cacheDigest","a".repeat(64)],["sourceRevision","b".repeat(64)],["metadataRevision","c".repeat(64)],["verifiedAt","2027-01-01T00:00:00Z"]]){
    await fs.writeFile(proofFile,JSON.stringify(rehash({...proof,[key]:value})));assert.equal((await f.service.get(ID,{month:MONTH})).status,"refreshing",key);
  }
  await fs.writeFile(proofFile,JSON.stringify({...proof,generation:99}));assert.equal((await f.service.get(ID,{month:MONTH})).status,"refreshing","unchecked content change");
  await fs.writeFile(proofFile,"{broken");assert.equal((await f.service.get(ID,{month:MONTH})).status,"refreshing","corrupt JSON");
  await fs.writeFile(proofFile,original);assert.equal((await f.service.get(ID,{month:MONTH})).status,"ready");
  const monthOriginal=await fs.readFile(f.monthFile,"utf8"),stored=JSON.parse(monthOriginal);stored.snapshot.summary.lodging.sold=999;
  await fs.writeFile(f.monthFile,JSON.stringify(stored));assert.notEqual((await f.service.get(ID,{month:MONTH})).status,"ready","a modified cache cannot be certified by the old digest");
  await fs.writeFile(f.monthFile,monthOriginal);assert.equal((await f.service.get(ID,{month:MONTH})).status,"ready");
});

test("failure in a different month remains visible but does not hide a verified successful selected month", async t=>{
  const f=await fixture(t);await f.service.queueCompany(ID,{months:[MONTH,"2026-10"]});await f.service.refreshMonth(ID,{month:MONTH});
  f.state.beforeReturn=async request=>{if(request.month==="2026-10")throw Object.assign(Error("private detail"),{code:"OTHER_MONTH_SOURCE_FAILED"});};
  await f.service.drain();const queue=await f.queue(),view=await f.service.get(ID,{month:MONTH});
  assert.equal(view.status,"ready");assert.equal(view.errorCode,null);assert.equal(view.freshness.refreshStatus,"failed");assert.equal(view.freshness.lastRefreshError,"OTHER_MONTH_SOURCE_FAILED");
  assert.equal(await f.queue(),queue);assert.equal((await f.service.get(ID,{month:"2026-10"})).status,"failed");
});

test("failed revision verification never labels a repaired month ready and recovers without rewriting it", async t=>{
  const f=await fixture(t);await f.service.queueCompany(ID,{months:[MONTH,"2026-10"]});await f.service.refreshMonth(ID,{month:MONTH});
  const before=await fs.readFile(f.monthFile,"utf8"),queue=await f.queue();f.state.revisionFail=true;
  const failed=await f.service.get(ID,{month:MONTH});assert.equal(failed.status,"failed");assert.equal(failed.errorCode,"COMPANY_INTEGRATION_REVISION_UNAVAILABLE");assert.equal(failed.freshness.selectedMonthVerified,false);
  f.state.revisionFail=false;assert.equal((await f.service.get(ID,{month:MONTH})).status,"ready");assert.equal(await fs.readFile(f.monthFile,"utf8"),before);assert.equal(await f.queue(),queue);
});

test("a certificate write failure preserves the prior month proof and does not claim a successful new verification", async t=>{
  const f=await fixture(t);await f.service.queueCompany(ID,{months:[MONTH,"2026-10"]});await f.service.refreshMonth(ID,{month:MONTH});
  const proofFile=path.join(f.directory,`${MONTH}.refresh-proof.json`),original=await fs.readFile(proofFile,"utf8"),queue=await f.queue();
  f.state.revision++;const rename=fs.rename;fs.rename=async(from,to)=>{if(to===proofFile)throw Object.assign(Error("private write path"),{code:"EACCES"});return rename(from,to);};
  try{await assert.rejects(f.service.refreshMonth(ID,{month:MONTH}),{code:"EACCES"});}finally{fs.rename=rename;}
  assert.equal(await fs.readFile(proofFile,"utf8"),original);assert.equal((await f.service.get(ID,{month:MONTH})).status,"refreshing");assert.equal(await f.queue(),queue);
  await f.service.refreshMonth(ID,{month:MONTH});assert.equal((await f.service.get(ID,{month:MONTH})).status,"ready");
});

test("a new bootstrap failure invalidates an old certificate until that exact month is explicitly reverified", async t=>{
  const f=await fixture(t);await f.service.queueCompany(ID,{months:[MONTH,"2026-10"]});await f.service.refreshMonth(ID,{month:MONTH});
  f.state.revisionFail=true;await assert.rejects(f.service.bootstrap(),{code:"COMPANY_INTEGRATION_REVISION_UNAVAILABLE"});f.state.revisionFail=false;
  assert.equal((await f.service.get(ID,{month:MONTH})).status,"failed");const queue=await f.queue();
  await f.service.refreshMonth(ID,{month:MONTH});const view=await f.service.get(ID,{month:MONTH});assert.equal(view.status,"ready");assert.equal(view.freshness.selectedMonthVerified,true);
  assert.equal(await f.queue(),queue);assert.equal((await f.service.get(ID,{month:"2026-10"})).status,"failed");
});

test("a generation changed while checking the certificate cannot receive the former success", async t=>{
  const f=await fixture(t);await f.service.queueCompany(ID,{months:[MONTH,"2026-10"]});await f.service.refreshMonth(ID,{month:MONTH});
  let once=true;f.state.beforeRevision=async()=>{if(once){once=false;await f.service.queueCompany(ID,{months:["2026-11"],reason:"changed_during_proof_read"});}};
  const view=await f.service.get(ID,{month:MONTH});assert.equal(view.status,"refreshing");assert.equal(view.freshness.selectedMonthVerified,false);
  assert.deepEqual((await f.service.status()).jobs[0].months,[MONTH,"2026-10","2026-11"]);
});

test("normal ready idle reads keep their existing fast path without a new revision or inventory read", async t=>{
  const f=await fixture(t);await f.service.queueCompany(ID,{months:[MONTH]});await f.service.refreshMonth(ID,{month:MONTH});await f.service.drain();
  const revisions=f.state.revisionCalls,reads=f.reads.length,view=await f.service.get(ID,{month:MONTH});assert.equal(view.status,"ready");
  assert.equal(f.state.revisionCalls,revisions);assert.equal(f.reads.length,reads);assert.equal(view.freshness.selectedMonthVerified,false,"no certificate read is required for an ordinary completed company job");
});

test("without a scoped dependency revision a repair cannot certify the pending company's month", async t=>{
  const f=await fixture(t);await f.service.stop();const service=createCompanyIntegratedDb({...f.options,readRevision:undefined});
  try{
    await service.queueCompany(ID,{months:[MONTH,"2026-10"]});await service.refreshMonth(ID,{month:MONTH});
    const view=await service.get(ID,{month:MONTH});assert.equal(view.status,"refreshing");assert.equal(view.freshness.selectedMonthVerified,false);
    await assert.rejects(fs.readFile(path.join(f.directory,`${MONTH}.refresh-proof.json`)),{code:"ENOENT"});
  }finally{await service.stop();}
});
