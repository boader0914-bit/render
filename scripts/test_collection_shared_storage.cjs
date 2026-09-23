"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { AsyncLocalStorage } = require("node:async_hooks");
const { serialExecutor } = require("./collection_reuse.cjs");
const { allowsDerivedUpdates, inspectManifest } = require("./daily_collection_quality.cjs");

const serverSource = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
const start = serverSource.indexOf("async function appendHistoryForRun(...args)");
const end = serverSource.indexOf("\nfunction historyDayIndex(", start);
assert.ok(start >= 0 && end > start, "extract the actual server history wrapper and implementation");
const historySource = serverSource.slice(start, end);
const plain = value => JSON.parse(JSON.stringify(value));
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function completeManifest() {
  return {
    workerCollection: true,
    collectionProfileFlags: { collectBookingStock: true },
    naverAttemptedQueries: [{ status: 200 }],
    counts: {
      naverOverall: 2, naverBookingStockEligible: 2, naverBookingStockChecked: 2, naverBookingStockSucceeded: 2,
      naverOtaObservationChecked: 2, naverOtaBlocked: 0, naverOtaFailed: 0,
      naverScheduleRequested: 2, naverScheduleSucceeded: 2, naverScheduleFailed: 0, naverScheduleBlocked: 0
    }
  };
}

function harness({ initial = [], manifest = completeManifest() } = {}) {
  const rows = plain(initial);
  const evidence = [];
  const appends = [];
  const loadCalls = [];
  const lane = new AsyncLocalStorage();
  const calls = { mkdir: 0, activeLoads: 0, maximumActiveLoads: 0 };
  const observations = [
    { observationId: "fixture-run:room-a:2026-09-23", runId: "fixture-run", companyId: "room-a", supply: 21, sold: 2 },
    { observationId: "fixture-run:room-b:2026-09-23", runId: "fixture-run", companyId: "room-b", supply: 7, sold: 0 }
  ];
  const sharedWrite = serialExecutor();
  const context = {
    sharedWrite,
    fs: { existsSync: () => true },
    fsp: {
      mkdir: async () => { calls.mkdir++; },
      appendFile: async (_file, body, encoding) => {
        assert.equal(encoding, "utf8");
        await nextTurn();
        const added = body.trim().split("\n").map(line => JSON.parse(line));
        appends.push(added);
        rows.push(...added);
      }
    },
    HISTORY_DIR: "fixture/history",
    HISTORY_OBSERVATIONS_FILE: "fixture/history/observations.jsonl",
    resolveRunDir: runId => `fixture/outputs/${runId}`,
    readManifest: async () => manifest,
    allowsDerivedUpdates,
    loadRun: async (runId, options) => {
      calls.activeLoads++;
      calls.maximumActiveLoads = Math.max(calls.maximumActiveLoads, calls.activeLoads);
      loadCalls.push({ runId, lane: lane.getStore(), options: plain(options) });
      try {
        await nextTurn();
        // Actual loadRun performs a nested company-master update under the same
        // sharedWrite lock. Exercise that reentrant path without a real server.
        await sharedWrite(async () => {
          assert.equal(lane.getStore(), loadCalls.at(-1).lane);
          await nextTurn();
        });
        return { run: { runId, collectedAt: "2026-09-23T01:00:00.000Z" } };
      } finally { calls.activeLoads--; }
    },
    runCollectionDbRoute: () => ({ appliesHistory: true }),
    readHistoryObservations: async () => { await nextTurn(); return plain(rows); },
    buildHistoryObservations: () => plain(observations),
    masterDbDualWriteQueue: { mode: "shadow" },
    storeRunHistoryEvidence: async (runId, completeRows) => {
      await nextTurn();
      evidence.push({ runId, observations: plain(completeRows), lane: lane.getStore() });
      return { file: "history/evidence/fixture-run__full.json", observationCount: completeRows.length, sha256: "fixture-full-hash" };
    }
  };
  const append = vm.runInNewContext(`${historySource}\nappendHistoryForRun;`, context);
  return { append, lane, rows, observations, evidence, appends, calls, loadCalls };
}

test("concurrent completion and GET repair append each observation once while preserving both lane contexts", async () => {
  const store = harness();
  const results = await Promise.all([
    store.lane.run("manual", () => store.append("fixture-run")),
    store.lane.run("scheduled", () => store.append("fixture-run")),
    store.lane.run("get-repair", () => store.append("fixture-run"))
  ]);
  assert.deepEqual(results.map(result => result.appended), [2, 0, 0]);
  assert.deepEqual(results.map(result => result.observationCount), [2, 2, 2]);
  assert.equal(store.appends.length, 1);
  assert.equal(store.rows.length, 2);
  assert.equal(new Set(store.rows.map(row => row.observationId)).size, 2);
  assert.equal(store.calls.maximumActiveLoads, 1);
  assert.deepEqual(store.loadCalls.map(call => call.lane), ["manual", "scheduled", "get-repair"]);
  assert.deepEqual(store.evidence.map(call => call.lane), ["manual", "scheduled", "get-repair"]);
  for (const call of store.evidence) assert.deepEqual(call.observations, store.observations);
});

test("partial prior JSONL append keeps full immutable evidence and reports new versus total observation counts", async () => {
  const first = harness().observations[0];
  const store = harness({ initial: [first] });
  const result = await store.append("fixture-run");
  assert.equal(result.appended, 1);
  assert.equal(result.observationCount, 2);
  assert.equal(result.evidence.observationCount, 2);
  assert.deepEqual(store.evidence[0].observations, store.observations);
  assert.deepEqual(store.appends[0], [store.observations[1]]);
  assert.deepEqual(store.rows, store.observations);

  const repeated = await store.append("fixture-run");
  assert.equal(repeated.appended, 0);
  assert.equal(repeated.observationCount, 2);
  assert.equal(store.appends.length, 1);
  assert.deepEqual(store.evidence[1].observations, store.observations);
});

test("failed, partial and provider-blocked results cannot load derived data or write history/evidence", async () => {
  const failed = completeManifest(); failed.collectionFailed = true;
  const partial = completeManifest(); partial.counts.naverBookingStockSucceeded = 1;
  const blocked = completeManifest(); blocked.requestPacing = { guardEnabled: true, blockedStatus: 200, blockedCode: "NAVER_CAPTCHA" };
  for (const [manifest, status] of [[failed, "failed"], [partial, "partial"], [blocked, "blocked"]]) {
    assert.equal(inspectManifest(manifest).status, status);
    const store = harness({ manifest });
    const result = await store.append("fixture-run");
    assert.equal(result.appended, 0);
    assert.equal(result.reason, "scheduled_collection_quality_hold");
    assert.equal(store.loadCalls.length, 0);
    assert.equal(store.evidence.length, 0);
    assert.equal(store.appends.length, 0);
    assert.equal(store.calls.mkdir, 0);
    assert.deepEqual(store.rows, []);
  }
});
