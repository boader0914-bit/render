"use strict";
// Synthetic source bodies exceed the child's heap budget. No production input
// is copied, and no provider is contacted. A passing child proves that this
// connection does not require whole-company/history bodies in its JS heap.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { spawn } = require("node:child_process");

test("one linked company is available from large unrelated sources with a 64 MiB child heap", { timeout: 60000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "insight-scoped-memory-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  const master = path.join(directory, "company_master", "companies.json"), history = path.join(directory, "history", "observations.jsonl");
  await fs.mkdir(path.dirname(master), { recursive: true }); await fs.mkdir(path.dirname(history), { recursive: true });
  const company = { companyId: "cmp_selected", primaryName: "모의 검수 업체", manualCorrection: { lodgingBasisTotal: 16 }, keywords: {} };
  const masterHandle = await fs.open(master, "wx");
  try {
    await masterHandle.write('{"companies":{"cmp_selected":' + JSON.stringify(company));
    const padding = "synthetic-unrelated-evidence".repeat(20000);
    for (let index = 0; index < 192; index++) await masterHandle.write(',"cmp_other_' + index + '":' + JSON.stringify({ companyId: "cmp_other_" + index, keywords: {}, inventory: { padding } }));
    await masterHandle.write("}}");
  } finally { await masterHandle.close(); }
  const historyHandle = await fs.open(history, "wx");
  try {
    await historyHandle.write(JSON.stringify({ observationId: "selected-zero", companyKey: company.companyId, sold: 0, price: 0 }) + "\n");
    const padding = "unrelated-history-evidence".repeat(90);
    for (let batch = 0; batch < 320; batch++) {
      const lines = Array.from({ length: 256 }, (_, index) => JSON.stringify({ observationId: "unrelated-" + (batch * 256 + index), companyKey: "cmp_other_" + index % 96, padding }));
      await historyHandle.write(lines.join("\n") + "\n");
    }
    await historyHandle.write(JSON.stringify({ observationId: "selected-unknown", companyId: company.companyId, sold: null, price: null, missing: true }) + "\n");
  } finally { await historyHandle.close(); }
  const masterBytes = (await fs.stat(master)).size, historyBytes = (await fs.stat(history)).size;
  assert.ok(masterBytes > 96 * 1024 * 1024); assert.ok(historyBytes > 180 * 1024 * 1024);
  const script = `
    const assert = require('node:assert/strict'), fs = require('node:fs/promises'),v8=require('node:v8');
    const {createInsightCompanyDetailReader} = require(${JSON.stringify(require.resolve("./lib/insight_company_detail_reader.cjs"))});
    const {createAnalyticalWorkScheduler} = require(${JSON.stringify(require.resolve("./lib/analytical_work_scheduler.cjs"))});
    const root = ${JSON.stringify(directory)}, originals = new Set([${JSON.stringify(master)}, ${JSON.stringify(history)}]);
    const originalRead = fs.readFile; let forbiddenBodyReads=0, externalRequests=0, peakHeap=0;
    fs.readFile = async function(file, ...args) { if(originals.has(String(file))) { forbiddenBodyReads++; throw Error('Whole source read forbidden'); } return originalRead.call(this,file,...args); };
    global.fetch = async()=>{externalRequests++; throw Error('External requests forbidden');};
    const monitor=setInterval(()=>{peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);},5);
    const scheduler=createAnalyticalWorkScheduler();
    const read=createInsightCompanyDetailReader({dataDir:root,projectionVersion:'limited-heap-v1',runWork:(fn,opts)=>scheduler.run(fn,opts),
      dayKey:()=> '2026-10-23',runIdsForCompany:()=>[],identityForCompany:company=>({companyIds:new Set([company.companyId])}),
      summarize:async(id,{strictIdentity,includeObservationFlow,detailSources})=>{
        assert.equal(strictIdentity,true); assert.equal(includeObservationFlow,false); assert.equal(scheduler.status().active,true);
        assert.equal(Object.keys(detailSources.master.companies).length,193);
        assert.equal(detailSources.master.companies.cmp_other_0.inventory,undefined);
        return {company:detailSources.master.companies[id],rows:detailSources.observations};
      }});
    (async()=>{try{
      const first=await read('cmp_selected'),saved=await read('cmp_selected');
      assert.equal(first.rows.length,2);assert.equal(first.rows[0].sold,0);assert.equal(first.rows[1].sold,null);assert.equal(first.rows[1].missing,true);
      assert.deepEqual(saved,first);assert.equal(first.company.manualCorrection.lodgingBasisTotal,16);
      assert.equal(forbiddenBodyReads,0);assert.equal(externalRequests,0);
      const heapLimitBytes=v8.getHeapStatistics().heap_size_limit;assert.ok(heapLimitBytes<=64*1024*1024);
      console.log(JSON.stringify({heapLimitBytes,peakSampledHeapBytes:peakHeap,selectedRows:first.rows.length,forbiddenBodyReads,externalRequests}));
    }finally{clearInterval(monitor);await scheduler.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  const child = spawn(process.execPath, ["--max-old-space-size=48", "--max-semi-space-size=4", "-e", script], { windowsHide: true, env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { errors += data; });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
  const timeout = setTimeout(() => child.kill(), 45000);
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill(); });
  const result = await exited; clearTimeout(timeout);
  assert.equal(result.code, 0, errors.slice(-12000)); assert.equal(result.signal, null, errors.slice(-12000));
  const facts = JSON.parse(output.trim()); assert.equal(facts.selectedRows, 2); assert.equal(facts.forbiddenBodyReads, 0); assert.equal(facts.externalRequests, 0);
  t.diagnostic(JSON.stringify({ masterBytes, historyBytes, ...facts }));
});
