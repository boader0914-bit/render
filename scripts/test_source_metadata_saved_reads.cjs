"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const { createSourceReadScheduler } = require("./lib/source_read_scheduler.cjs");
const { createRevisionCheckedCompanyCatalog } = require("./lib/company_integrated_catalog.cjs");
const gate = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

test("source metadata lending requires explicit opt in and an exact background owner", async () => {
  for (const [enabled, kind, priority] of [[false,"source-options","background"], [true,"source-options","foreground"],
    [true,"source-targets","background"], [true,"bootstrap","background"]]) {
    const scheduler = createAnalyticalWorkScheduler({ sourceMetadataSavedReads: enabled }), entered = gate(), finish = gate();
    const owner = scheduler.run(async () => { entered.resolve(); await finish.promise; }, { kind, priority });
    await entered.promise;
    assert.throws(() => scheduler.acquireSavedReadPermit(), { code: "KEYWORD_MONTHLY_ANALYTICAL_BUSY" });
    assert.equal(scheduler.status().queuedCheckpointReads, 0);
    finish.resolve(); await owner; await scheduler.close();
  }
  assert.throws(() => createAnalyticalWorkScheduler({ sourceMetadataSavedReads: 1 }), TypeError);
});

test("metadata lending inherits only the existing industry opt in and can be explicitly disabled", async () => {
  for (const kind of ["source-options", "source-catalog", "verified-company-catalog"]) {
    for (const [options, allowed] of [[{},false], [{cooperativeCompanyMonthYield:true},false],
      [{cooperativeYield:true,sourceMetadataSavedReads:false},false], [{cooperativeYield:true},true]]) {
      const scheduler = createAnalyticalWorkScheduler(options), source = createSourceReadScheduler(), entered = gate(), proceed = gate();
      const owner = scheduler.run(async () => { entered.resolve(); await proceed.promise; await source.checkpoint({priority:"background"}); }, {kind,priority:"background"});
      await entered.promise;
      if (allowed) {
        const permit = scheduler.acquireSavedReadPermit(), ready = permit.run(() => 0);
        proceed.resolve(); assert.equal(await ready,0); permit.release(); await permit.waitForRelease();
      } else { assert.throws(() => scheduler.acquireSavedReadPermit(),{code:"KEYWORD_MONTHLY_ANALYTICAL_BUSY"}); proceed.resolve(); }
      await owner; assert.equal(scheduler.status().timing.restarted,0); await scheduler.close();
    }
  }
});

test("the production verified catalog outer lease lends at its nested source boundary and returns identical data once", async () => {
  const scheduler = createAnalyticalWorkScheduler({ sourceMetadataSavedReads: true }), source = createSourceReadScheduler();
  const entered = gate(), proceed = gate(), readEntered = gate(), readFinish = gate(), graph = { companies: [{ companyId:"fixture" }], runs:[] };
  let attempts = 0, resumed = false, revisions = 0;
  const catalog = createRevisionCheckedCompanyCatalog({ readRevision: async () => { revisions++; return "same-revision"; },
    runWork: (work, options) => scheduler.run(work, options),
    catalog: options => scheduler.run(() => source.run(async () => {
      attempts++; entered.resolve(); await proceed.promise; await source.checkpoint(options); resumed = true; return graph;
    }, options), { ...options, kind:"source-catalog" }) });
  const result = catalog({ priority:"background" }); await entered.promise;
  assert.equal(scheduler.status().activeKind, "verified-company-catalog");
  const permit = scheduler.acquireSavedReadPermit();
  const saved = permit.run(async () => { readEntered.resolve(); await readFinish.promise; return { actualZero:0, missing:null }; });
  proceed.resolve(); await readEntered.promise; await turn();
  assert.equal(resumed, false); assert.equal(attempts, 1);
  readFinish.resolve(); assert.deepEqual(await saved, { actualZero:0, missing:null }); await turn();
  assert.equal(resumed, false); // A settled producer does not release its HTTP/encoding loan.
  permit.release(); await permit.waitForRelease(); assert.equal(await result, graph);
  assert.equal(attempts, 1); assert.equal(revisions, 2);
  assert.equal(scheduler.status().timing.restarted, 0); assert.equal(source.status().active, false);
  await scheduler.close();
});
