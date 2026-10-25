"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { Readable } = require("node:stream");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const { readScopedCompanyMaster, readScopedCompanyHistory } = require("./lib/company_detail_store.cjs");
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

for (const kind of ["master", "history"]) test(`a real scoped ${kind} reader lends a safe boundary while a foreground detail remains active`, async () => {
  const scheduler = createAnalyticalWorkScheduler(), entered = gate(), proceed = gate(), events = [];
  const rows = Array.from({ length: 1024 }, (_, index) => ({ observationId: "obs-" + index, companyId: index % 2 ? "other" : "own", sold: index === 0 ? null : 0 }));
  const company = { companyId: "own", keywords: {} };
  const bytes = kind === "master" ? JSON.stringify({ companies: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [index ? "other-" + index : "own", index ? { companyId: "other-" + index, keywords: {} } : company])) })
    : rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  const stream = () => Readable.from((async function* () { entered.resolve(); await proceed.promise; yield bytes; })());
  const detail = scheduler.run(async () => {
    events.push("detail-start");
    const result = kind === "master" ? await readScopedCompanyMaster("synthetic-master", "own", { stream })
      : await readScopedCompanyHistory("synthetic-history", company, row => row.companyId === "own", { stream });
    events.push("detail-finished"); return result;
  }, { priority: "foreground", kind: "company-detail" });
  try {
    await entered.promise;
    const proof = scheduler.runCheckpointRead(async () => {
      assert.equal(scheduler.status().activeKind, "company-detail");
      assert.equal(scheduler.status().cooperative.activeEligible, false);
      events.push("proof"); return "verified";
    });
    proceed.resolve(); assert.equal(await proof, "verified"); const result = await detail;
    assert.deepEqual(events, ["detail-start", "proof", "detail-finished"]);
    if (kind === "master") assert.equal(result.companies.own.companyId, "own");
    else { assert.equal(result.length, 512); assert.equal(result[0].sold, null); assert.equal(result[1].sold, 0); }
    assert.equal(scheduler.status().timing.yielded, 0); assert.equal(scheduler.status().timing.restarted, 0);
  } finally { proceed.resolve(); await detail.catch(() => {}); await scheduler.close(); }
});
