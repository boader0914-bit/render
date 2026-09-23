const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { collectionEnv, dispatchCollector, createHistoricalBookingContext } = require("./collector_dispatch.cjs");

test("dispatch transfers only collection settings and returns canonical artifacts", async () => {
  const received = [];
  const completed = { id: "job", status: "completed", runId: "fixture", manifest: { outputDir: "/server/outputs/fixture" } };
  const broker = {
    submit: async value => { received.push(value); return { id: "job", status: "queued" }; },
    getJob: async () => completed
  };
  const env = { CHECK_IN: "2026-09-23", ADMIN_PASSWORD: "private-fixture", COLLECTOR_WORKER_TOKEN: "private-fixture", DATA_DIR: "/server/data", NODE_OPTIONS: "unsafe", NAVER_REQUEST_MIN_INTERVAL_MS: 200,
    NAVER_SCHEDULE_DELAY_MS: 150, NAVER_OTA_OBSERVATION_LIMIT: 5, NAVER_BOOKING_ID_FALLBACK: "0" };
  const actual = await dispatchCollector({ broker, keyword: "포천글램핑", env, payload: {}, context: { historicalBookingBusinesses: [] } });
  assert.equal(actual, completed);
  assert.deepEqual(received[0].env, { CHECK_IN: "2026-09-23", NAVER_REQUEST_MIN_INTERVAL_MS: "200",
    NAVER_SCHEDULE_DELAY_MS: "150", NAVER_OTA_OBSERVATION_LIMIT: "5", NAVER_BOOKING_ID_FALLBACK: "0" });
  assert.deepEqual(collectionEnv({}), {});
});

test("unavailable worker fails without executing a crawler", async () => {
  await assert.rejects(dispatchCollector({
    broker: { submit: async () => { throw new Error("internal sensitive detail"); } },
    keyword: "fixture", env: {}, payload: {}
  }), error => error.code === "COLLECTOR_WORKER_UNAVAILABLE" && !error.message.includes("sensitive"));
});

test("submission preserves safe failure codes without passing through raw details", async () => {
  for (const [code, expected] of [["COLLECTOR_PROVIDER_BLOCKED", "COLLECTOR_PROVIDER_BLOCKED"], ["COLLECTOR_DISABLED", "COLLECTOR_DISABLED"], ["https://private?token=123", "COLLECTOR_WORKER_UNAVAILABLE"]]) {
    await assert.rejects(dispatchCollector({
      broker: { submit: async () => { throw Object.assign(new Error("private credential content"), { code }); } },
      keyword: "fixture", env: {}, payload: {}
    }), error => error.code === expected && error.cancelled === false && !error.message.includes("private"));
  }
});

test("failed and interrupted jobs retain safe receipt error codes", async () => {
  for (const status of ["failed", "interrupted"]) {
    for (const [code, expected] of [["COLLECTOR_LEASE_EXPIRED", "COLLECTOR_LEASE_EXPIRED"], ["COLLECTOR_UPLOAD_FAILED", "COLLECTOR_UPLOAD_FAILED"], ["token=private", "COLLECTOR_WORKER_INTERRUPTED"]]) {
      await assert.rejects(dispatchCollector({
        broker: { submit: async () => ({ id: "job" }), getJob: async () => ({ id: "job", status, errorCode: code }) },
        keyword: "fixture", env: {}, payload: {}
      }), error => error.code === expected && error.cancelled === false && !error.message.includes("private"));
    }
  }
});

test("provider block takes priority over cancelled receipt and simultaneous cancellation request", async () => {
  for (const status of ["cancelled", "failed", "interrupted"]) {
    for (const cancellationRequested of [false, true]) {
      await assert.rejects(dispatchCollector({
        broker: { submit: async () => ({ id: "job" }), cancel: async () => {}, getJob: async () => ({ id: "job", status, errorCode: "COLLECTOR_PROVIDER_BLOCKED" }) },
        keyword: "fixture", env: {}, payload: {}, isCancelled: () => cancellationRequested
      }), { code: "COLLECTOR_PROVIDER_BLOCKED", cancelled: false, statusCode: 409 });
    }
  }
});

test("explicit queue timeout cancels only that unclaimed job without halting the worker", async () => {
  let time = 0, cancellations = 0, halts = 0, submissions = 0;
  const broker = {
    submit: async () => { submissions++; return { id: "job" }; },
    getJob: async () => ({ id: "job", status: "queued" }),
    cancel: async () => { cancellations++; },
    halt: async code => { assert.equal(code, "COLLECTOR_WORKER_TIMEOUT"); halts++; }
  };
  await assert.rejects(dispatchCollector({
    broker, keyword: "fixture", env: {}, payload: {}, now: () => time,
    sleep: async () => { time += 10; }, queuedTimeoutMs: 15
  }), { code: "COLLECTOR_QUEUE_TIMEOUT" });
  assert.deepEqual([submissions, cancellations, halts], [1, 1, 0]);
});

test("normal queue waiting does not consume execution timeout or stop unrelated work", async () => {
  let time = 0, polls = 0;
  const broker = {
    submit: async () => ({ id: "job" }),
    getJob: async () => ({ id: "job", status: ++polls < 4 ? "queued" : polls < 6 ? "leased" : "completed" }),
    cancel: async () => { assert.fail("ordinary waiting must not cancel"); },
    halt: async () => { assert.fail("ordinary waiting must not halt"); }
  };
  const result = await dispatchCollector({ broker, keyword: "fixture", env: {}, payload: {}, now: () => time,
    sleep: async () => { time += 100000; }, timeoutMs: 150000 });
  assert.equal(result.status, "completed");
  assert.equal(polls, 6);
});

test("schedule pause cancels only an unclaimed job and reports cancellation without a halt", async () => {
  let state = "queued", withdrawals = 0;
  const broker = {
    submit: async () => ({ id: "paused-job", status: state }),
    cancelQueued: async (id, code) => { assert.equal(id, "paused-job"); assert.equal(code, "COLLECTOR_SCHEDULE_PAUSED"); withdrawals++; state = "cancelled"; return { id, status: state }; },
    getJob: async () => ({ id: "paused-job", status: state, errorCode: state === "cancelled" ? "COLLECTOR_SCHEDULE_PAUSED" : undefined }),
    cancel: async () => { assert.fail("pause must not use active-job cancellation"); },
    halt: async () => { assert.fail("schedule pause must not halt the broker"); }
  };
  await assert.rejects(dispatchCollector({ broker, keyword: "fixture", env: {}, payload: {}, shouldCancelQueued: () => true }), { code: "CRAWL_CANCELLED", cancelled: true });
  assert.equal(withdrawals, 1);
});

test("pause preserves work claimed before atomic withdrawal, including claim between submit and poll", async () => {
  let state = "queued", withdrawals = 0, polls = 0;
  const broker = {
    submit: async () => ({ id: "claimed-job", status: state }),
    cancelQueued: async id => {
      withdrawals++;
      // The claim wins before cancelQueued acquires the broker lock.
      if (state === "queued") state = "leased";
      return { id, status: state };
    },
    getJob: async () => ({ id: "claimed-job", status: ++polls >= 3 ? (state = "completed") : state }),
    cancel: async () => { assert.fail("schedule pause must not terminate a leased child"); },
    halt: async () => { assert.fail("schedule pause must not halt the broker"); }
  };
  const result = await dispatchCollector({ broker, keyword: "fixture", env: {}, payload: {}, shouldCancelQueued: () => true, sleep: async () => {} });
  assert.equal(result.status, "completed");
  assert.equal(withdrawals, 3);
  assert.equal(polls, 3);
});

test("scheduled observation-day deadline cancels only an unclaimed job", async () => {
  let time = 90, cancellations = 0;
  const broker = {
    submit: async input => { assert.equal(input.queueDeadline, 100); return { id: "job" }; },
    getJob: async () => ({ id: "job", status: "queued" }),
    cancel: async () => { cancellations++; },
    halt: async () => { assert.fail("expired queued work must not halt a broker"); }
  };
  await assert.rejects(dispatchCollector({ broker, keyword: "fixture", env: {}, payload: {}, queueDeadline: 100,
    now: () => time, sleep: async () => { time += 10; } }), { code: "COLLECTOR_QUEUE_DEADLINE" });
  assert.equal(cancellations, 1);
});

test("a collection already leased before the deadline may finish after midnight", async () => {
  let time = 90, polls = 0;
  const broker = {
    submit: async () => ({ id: "job" }),
    getJob: async () => ({ id: "job", status: ++polls < 4 ? "leased" : "completed" }),
    cancel: async () => { assert.fail("midnight does not cancel active work"); },
    halt: async () => { assert.fail("midnight does not halt a broker"); }
  };
  const result = await dispatchCollector({ broker, keyword: "fixture", env: {}, payload: {}, queueDeadline: 100,
    now: () => time, sleep: async () => { time += 10; } });
  assert.equal(result.status, "completed");
  assert.equal(time, 120);
});

test("cancel acknowledgement and interrupted jobs never become successful", async () => {
  for (const status of ["cancelled", "completed", "interrupted"]) {
    let cancels = 0;
    await assert.rejects(dispatchCollector({
      broker: { submit: async () => ({ id: "job" }), cancel: async () => { cancels++; }, getJob: async () => ({ id: "job", status }) },
      keyword: "fixture", env: {}, payload: {}, isCancelled: () => true
    }), { code: "CRAWL_CANCELLED", cancelled: true });
    assert.equal(cancels, 1);
  }
  await assert.rejects(dispatchCollector({
    broker: { submit: async () => ({ id: "job" }), getJob: async () => ({ id: "job", status: "interrupted" }) },
    keyword: "fixture", env: {}, payload: {}
  }), { code: "COLLECTOR_WORKER_INTERRUPTED" });
});

test("historical context contains only valid ID pairs and refreshes cached files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "collector-context-"));
  try {
    const dir = path.join(root, "run");
    await fs.mkdir(dir);
    const file = path.join(dir, "fixture_네이버전체순위.csv");
    const rows = [
      { place_id: "123", 네이버예약사업자ID: "456", private: "must never transfer" },
      { place_id: "../bad", 네이버예약사업자ID: "789" }
    ];
    await fs.writeFile(file, JSON.stringify(rows));
    const read = createHistoricalBookingContext({ outputsDir: root, parseCsv: JSON.parse });
    assert.deepEqual(await read(), { historicalBookingBusinesses: [{ placeId: "123", businessId: "456" }] });
    await fs.writeFile(file, JSON.stringify([{ place_id: "123", 네이버예약사업자ID: "99999" }]));
    assert.deepEqual(await read(), { historicalBookingBusinesses: [{ placeId: "123", businessId: "99999" }] });
  } finally {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
