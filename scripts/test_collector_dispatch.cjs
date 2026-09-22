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

test("unclaimed job times out once and durably halts", async () => {
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
  }), { code: "COLLECTOR_WORKER_UNAVAILABLE" });
  assert.deepEqual([submissions, cancellations, halts], [1, 1, 1]);
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
