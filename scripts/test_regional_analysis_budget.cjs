"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createDemandStrengthBackfillScheduler } = require("./tourism_demand_strength_backfill_scheduler.cjs");
const collector = { readRegionMap: async () => ({ regions: [] }), status: async () => ({}), collectDemandStrength: async () => { throw new Error("External collection forbidden"); } };
for (const months of [13, 24]) test(`${months}-month regional refresh reserves the shared budget without changing automatic backfill`, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "regional-budget-"));
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
  const scheduler = createDemandStrengthBackfillScheduler({ collector, stateFile: path.join(directory, "state.json"),
    now: () => new Date("2026-10-15T00:00:00Z"), enabled: false, dailyCallBudget: 48 });
  const result = await scheduler.beginManualReservation({ months, maxPagesPerOperation: 1 });
  assert.equal(result.requestedCalls, months * 2);
  assert.equal(result.budget.reservedCalls, months * 2);
  assert.equal(result.budget.limitCalls, 48);
  await scheduler.finishManualReservation({ reservationId: result.reservationId, actualCalls: 2 });
  const stored = JSON.parse(await fs.readFile(path.join(directory, "state.json")));
  assert.equal(stored.dailyBudget.usedCalls, 2); assert.equal(stored.dailyBudget.reservedCalls, 0);
});
test("13-month request still fails if existing shared daily budget is insufficient", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "regional-budget-"));
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
  const scheduler = createDemandStrengthBackfillScheduler({ collector, stateFile: path.join(directory, "state.json"), enabled: false,
    now: () => new Date("2026-10-15T00:00:00Z"), dailyCallBudget: 24 });
  await assert.rejects(() => scheduler.beginManualReservation({ months: 13 }), error => error.statusCode === 429);
});
