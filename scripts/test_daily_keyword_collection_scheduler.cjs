const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  createDailyKeywordCollectionScheduler, defaultConfig, KEYWORDS, MIN_FREE_BYTES, dateKey, addDays,
  validateConfig, lowLoadRequestPacing
} = require("./daily_keyword_collection_scheduler.cjs");

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

async function fixture(overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "staydatalab-daily-test-"));
  const configFile = path.join(dataDir, "config", "daily_keyword_collection.json");
  const stateFile = path.join(dataDir, "history", "daily_keyword_collection_state.json");
  const calls = [];
  let currentTime = new Date("2026-09-20T05:00:00Z");
  const config = { ...defaultConfig(), enabled: true };
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, JSON.stringify(config));
  const options = {
    dataDir, configFile, stateFile, now: () => currentTime,
    isBusy: () => false, getFreeBytes: async () => 1000 * 1024 * 1024,
    logger: { warn() {} },
    runCrawler: async (payload) => {
      calls.push(payload);
      currentTime = new Date(currentTime.getTime() + 2000);
      return { runId: `run_${calls.length}`, output: { counts: { naverOverall: 20 } } };
    },
    inspectResult: () => ({ status: "complete", counts: { mainCount: 20 } }), ...overrides
  };
  const scheduler = createDailyKeywordCollectionScheduler(options);
  return {
    dataDir, configFile, stateFile, config, calls, options, scheduler,
    setTime: (value) => { currentTime = new Date(value); },
    writeConfig: (value) => fs.writeFile(configFile, typeof value === "string" ? value : JSON.stringify(value)),
    state: async () => JSON.parse(await fs.readFile(stateFile, "utf8")),
    close: async () => { scheduler.stop(); await fs.rm(dataDir, { recursive: true, force: true }); }
  };
}

test("KST date, month/year rollover, and exact 14:00 boundary", async () => {
  assert.equal(dateKey("2026-09-20T15:00:00Z"), "2026-09-21");
  assert.equal(addDays("2026-12-20", 30), "2027-01-19");
  const f = await fixture();
  try {
    f.setTime("2026-09-20T04:59:59.999Z");
    await f.scheduler.tick();
    assert.equal(f.calls.length, 0);
    assert.equal((await f.scheduler.status()).nextRunAt, "2026-09-20T05:00:00.000Z");
    f.setTime("2026-09-20T05:00:00Z");
    await f.scheduler.tick();
    assert.deepEqual(f.calls.map((p) => p.keyword), KEYWORDS);
    assert.ok(f.calls.every((p) => p.checkIn === "2026-09-20" && p.checkOut === "2026-10-20"
      && p.bookingRangeDays === 31 && p.detailRankRanges === "1-20" && p.bookingRangePlaceLimit === 20
      && p.scheduledCollection === true && p.collectionPurpose === "revenue_detail"));
    const status = await f.scheduler.status();
    assert.equal(status.nextRunAt, "2026-09-21T05:00:00.000Z");
    assert.ok(status.items.every((item) => item.status === "completed" && item.durationMs === 2000));
  } finally { await f.close(); }
});

test("completed jobs never repeat on same-day ticks or restart", async () => {
  const f = await fixture();
  try {
    await f.scheduler.tick();
    await f.scheduler.tick();
    const fresh = createDailyKeywordCollectionScheduler(f.options);
    await fresh.tick();
    assert.equal(f.calls.length, 13);
    f.setTime("2026-09-21T05:00:00Z");
    await fresh.tick();
    assert.equal(f.calls.length, 26);
    assert.equal(Object.keys((await f.state()).days).length, 2);
  } finally { await f.close(); }
});

test("future low-load CLI preserves today's legacy ledger and starts on the selected KST date", async () => {
  const f = await fixture();
  try {
    f.setTime("2026-09-21T05:00:00Z");
    await f.scheduler.tick();
    const state = await f.state();
    // Legacy records did not include pacing or batch timing metadata.
    const oldDay = state.days["2026-09-21"];
    delete oldDay.requestPacing;
    delete oldDay.startedAt;
    delete oldDay.durationMs;
    oldDay.items.forEach((item) => { delete item.requestPacing; });
    const original = JSON.stringify(state, null, 2);
    await fs.writeFile(f.stateFile, original);
    const cli = spawnSync(process.execPath, [path.join(__dirname, "configure_daily_collection.cjs"),
      "--low-load-from", "2026-09-22", "--data-dir", f.dataDir], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    const saved = JSON.parse(await fs.readFile(f.configFile, "utf8"));
    assert.equal(saved.enabled, true);
    assert.deepEqual(saved.keywords, KEYWORDS);
    assert.equal(saved.hour, 14);
    assert.equal(saved.bookingDays, 31);
    assert.equal(saved.rankLimit, 20);
    const pacing = lowLoadRequestPacing("2026-09-22");
    assert.deepEqual(saved.requestPacing, pacing);
    assert.equal(await fs.readFile(f.stateFile, "utf8"), original);
    await f.scheduler.tick();
    assert.equal(f.calls.length, 13);
    assert.equal(await fs.readFile(f.stateFile, "utf8"), original);
    assert.equal((await f.scheduler.status()).requestPacing, null);
    assert.equal((await f.scheduler.status()).totalCollectionDurationMs, 26_000);
    f.setTime("2026-09-21T15:00:00Z"); // KST start date, still before 14:00.
    await f.scheduler.tick();
    assert.equal(f.calls.length, 13);
    assert.deepEqual((await f.scheduler.status()).requestPacing, pacing);
    f.setTime("2026-09-22T05:00:00Z");
    await f.scheduler.tick();
    assert.equal(f.calls.length, 26);
    assert.ok(f.calls.slice(13).every((payload) => JSON.stringify(payload.requestPacing) === JSON.stringify(pacing)));
    const status = await f.scheduler.status();
    assert.deepEqual(status.requestPacing, pacing);
    assert.ok(status.items.every((item) => item.durationMs === 2000 && item.requestPacing.maxConcurrentRequests === 2));
    assert.equal(status.durationMs, 26_000);
    assert.equal(status.totalCollectionDurationMs, 26_000);
    assert.deepEqual((await f.state()).days["2026-09-21"], oldDay);
    f.setTime("2026-09-23T05:00:00Z");
    await f.scheduler.tick();
    assert.equal(f.calls.length, 39);
    assert.deepEqual(f.calls[38].requestPacing, pacing); // No automatic return to higher load.
  } finally { await f.close(); }
});

test("low-load CLI retains disabled configuration and rejects invalid input without writes", async () => {
  const f = await fixture();
  try {
    await f.writeConfig({ ...f.config, enabled: false, minFreeBytes: MIN_FREE_BYTES * 2 });
    const invoke = (date) => spawnSync(process.execPath, [path.join(__dirname, "configure_daily_collection.cjs"),
      "--low-load-from", date, "--data-dir", f.dataDir], { encoding: "utf8" });
    const cli = invoke("2026-09-22");
    assert.equal(cli.status, 0, cli.stderr);
    const original = await fs.readFile(f.configFile, "utf8");
    const saved = JSON.parse(original);
    assert.equal(saved.enabled, false);
    assert.equal(saved.minFreeBytes, MIN_FREE_BYTES * 2);
    for (const invalid of ["2026-02-30", "2026-9-22", "garbage", "2026-09-22T00:00:00Z"]) {
      const result = invoke(invalid);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /invalid_daily_collection_request_pacing/);
      assert.equal(await fs.readFile(f.configFile, "utf8"), original);
    }
    await f.scheduler.tick();
    assert.equal(f.calls.length, 0);
    await assert.rejects(fs.access(f.stateFile), { code: "ENOENT" });
    assert.deepEqual((await fs.readdir(path.dirname(f.configFile))).sort(), ["daily_keyword_collection.json"]);
  } finally { await f.close(); }
});

test("pacing validates integer bounds and only a fixed trusted payload shape", async () => {
  const baseline = lowLoadRequestPacing("2026-09-22");
  for (const invalid of [null, [], { ...baseline, enabled: "true" }, { ...baseline, minIntervalMs: 0 },
    { ...baseline, minIntervalMs: 60_001 }, { ...baseline, detailConcurrency: 1.5 },
    { ...baseline, maxConcurrentRequests: 3 }, { ...baseline, maxConcurrentRequests: 9 }, { ...baseline, otaConcurrency: 0 },
    { ...baseline, extraEnvironment: "unsafe" }]) {
    assert.throws(() => validateConfig({ ...defaultConfig(), requestPacing: invalid }), /invalid_daily_collection_request_pacing/);
  }
  assert.equal(Object.hasOwn(validateConfig(defaultConfig()), "requestPacing"), false);
});

test("same-day effective pacing change halts remaining jobs without resetting history", async () => {
  let f;
  let count = 0;
  const pacing = lowLoadRequestPacing("2026-09-20");
  f = await fixture({ runCrawler: async () => {
    count += 1;
    await f.writeConfig({ ...f.config, requestPacing: { ...pacing, minIntervalMs: 1000 } });
    return { runId: "first" };
  } });
  try {
    await f.writeConfig({ ...f.config, requestPacing: pacing });
    await f.scheduler.tick();
    assert.equal(count, 1);
    const status = await f.scheduler.status();
    assert.equal(status.blockedReason, "same_day_configuration_changed");
    assert.deepEqual(status.requestPacing, pacing);
    assert.deepEqual(status.items[0].requestPacing, pacing);
    assert.equal(status.items[0].status, "completed");
    assert.equal(status.items[1].status, "pending");
  } finally { await f.close(); }
});

test("same-day catch-up preserves sequential await and duplicate-tick exclusion", async () => {
  let release;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  let count = 0;
  const f = await fixture({ runCrawler: async () => {
    count += 1;
    if (count === 1) { entered(); await pending; }
    return { runId: `run_${count}` };
  } });
  try {
    f.setTime("2026-09-20T10:00:00Z");
    const first = f.scheduler.tick();
    const second = f.scheduler.tick();
    assert.equal(first, second);
    await enteredPromise;
    assert.equal(count, 1);
    assert.equal((await f.state()).days["2026-09-20"].items[0].status, "running");
    release();
    await Promise.all([first, second]);
    assert.equal(count, 13);
  } finally { release(); await f.close(); }
});

test("no historical backfill and no new jobs after crossing KST midnight", async () => {
  let f;
  let count = 0;
  f = await fixture({ runCrawler: async () => {
    count += 1;
    f.setTime("2026-09-20T15:00:00Z");
    return { runId: `run_${count}` };
  } });
  try {
    f.setTime("2026-09-20T14:59:59Z");
    await f.scheduler.tick();
    assert.equal(count, 1);
    await f.scheduler.tick();
    assert.equal(count, 1);
    const oldDay = (await f.state()).days["2026-09-20"];
    assert.equal(oldDay.items.filter((item) => item.status === "pending").length, 12);
    assert.equal((await f.scheduler.status()).day, "2026-09-21");
  } finally { await f.close(); }
});

test("restart running job is interrupted without repeating it, remaining jobs continue", async () => {
  let busy = true;
  const f = await fixture({ isBusy: () => busy });
  try {
    await f.scheduler.tick();
    const state = await f.state();
    Object.assign(state.days["2026-09-20"].items[0], { status: "running", startedAt: "2026-09-20T05:00:00Z" });
    await fs.writeFile(f.stateFile, JSON.stringify(state));
    busy = false;
    const fresh = createDailyKeywordCollectionScheduler(f.options);
    await fresh.tick();
    assert.equal(f.calls.length, 12);
    assert.equal(f.calls[0].keyword, KEYWORDS[1]);
    assert.equal((await fresh.status()).items[0].status, "interrupted");
  } finally { await f.close(); }
});

test("manual collection causes wait, not a competing crawl", async () => {
  let busy = true;
  const f = await fixture({ isBusy: () => busy });
  try {
    await f.scheduler.tick();
    assert.equal(f.calls.length, 0);
    busy = false;
    await f.scheduler.tick();
    assert.equal(f.calls.length, 13);
  } finally { await f.close(); }
});

test("missing config defaults to disabled and malformed config fails closed", async () => {
  const f = await fixture();
  try {
    await fs.rm(f.configFile);
    await f.scheduler.tick();
    assert.equal((await f.scheduler.status()).enabled, false);
    for (const invalid of ["{", { ...f.config, bookingDays: 7 }, { ...f.config, minFreeBytes: 1 },
      { ...f.config, keywords: [...KEYWORDS].reverse() }, { ...f.config, timezone: "UTC" }]) {
      await f.writeConfig(invalid);
      await f.scheduler.tick();
      assert.equal((await f.scheduler.status()).enabled, false);
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("corrupt state is preserved and no jobs start", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.dirname(f.stateFile), { recursive: true });
    await fs.writeFile(f.stateFile, "broken original ledger");
    await f.scheduler.tick();
    assert.equal(f.calls.length, 0);
    assert.equal(await fs.readFile(f.stateFile, "utf8"), "broken original ledger");
    assert.ok((await f.scheduler.status()).blockedReason);
  } finally { await f.close(); }
});

test("disk space is checked before each keyword and blocks remainder for the day", async () => {
  let checks = 0;
  const f = await fixture({ getFreeBytes: async () => ++checks === 1 ? MIN_FREE_BYTES + 1024 : MIN_FREE_BYTES - 1 });
  try {
    await f.scheduler.tick();
    assert.equal(f.calls.length, 1);
    assert.equal((await f.scheduler.status()).blockedReason, "insufficient_disk_space");
    await f.scheduler.tick();
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("unreadable or invalid disk measurement fails closed", async () => {
  for (const getFreeBytes of [async () => { throw new Error("statfs denied"); }, async () => NaN, async () => "500000000"]) {
    const f = await fixture({ getFreeBytes });
    try {
      await f.scheduler.tick();
      assert.equal(f.calls.length, 0);
      assert.equal((await f.scheduler.status()).blockedReason, "disk_check_failed");
    } finally { await f.close(); }
  }
});

test("explicit 429, ENOSPC and administrator cancellation stop all remaining jobs", async () => {
  const errors = [
    [Object.assign(new Error("worker offline"), { code: "COLLECTOR_WORKER_UNAVAILABLE" }), "collector_worker_unavailable"],
    [Object.assign(new Error("lease expired"), { code: "COLLECTOR_WORKER_INTERRUPTED" }), "collector_worker_unavailable"],
    [Object.assign(new Error("throttled"), { statusCode: 429 }), "rate_limited"],
    [new Error("HTTP 429"), "rate_limited"],
    [new Error("NAVER_MAIN_BLOCKED HTTP 403"), "naver_main_http_403"],
    [new Error("NAVER_SCHEDULE_BLOCKED HTTP 403"), "naver_schedule_http_403"],
    [new Error("NAVER_SCHEDULE_BLOCKED HTTP 429"), "rate_limited"],
    [new Error("NAVER_REQUEST_BLOCKED HTTP 403"), "naver_request_http_403"],
    [new Error("NAVER_REQUEST_BLOCKED HTTP 429"), "rate_limited"],
    [Object.assign(new Error("captcha detected"), { code: "NAVER_REQUEST_BLOCKED" }), "naver_request_blocked"],
    [Object.assign(new Error("full"), { code: "ENOSPC" }), "disk_full"],
    [Object.assign(new Error("cancel"), { cancelled: true, statusCode: 499 }), "cancel_requested"],
    [Object.assign(new Error("cancel"), { code: "ABORT_ERR" }), "cancel_requested"],
    [Object.assign(new Error("cancel"), { code: "CRAWL_CANCELLED" }), "cancel_requested"]
  ];
  for (const [error, reason] of errors) {
    let count = 0;
    const f = await fixture({ runCrawler: async () => { count += 1; throw error; } });
    try {
      await f.scheduler.tick();
      await f.scheduler.tick();
      assert.equal(count, 1);
      assert.equal((await f.scheduler.status()).blockedReason, reason);
    } finally { await f.close(); }
  }
});

test("ordinary keyword failure continues, partial quality stays explicit", async () => {
  let count = 0;
  const f = await fixture({
    runCrawler: async () => {
      count += 1;
      if (count === 1) throw new Error("place 429123 unavailable");
      return { runId: `run_${count}` };
    },
    inspectResult: () => ({ status: "partial", reason: "some_details_missing", counts: { mainCount: 8 } })
  });
  try {
    await f.scheduler.tick();
    const status = await f.scheduler.status();
    assert.equal(count, 13);
    assert.equal(status.items[0].status, "failed");
    assert.equal(status.items[1].status, "partial");
    assert.equal(status.blockedReason, "");
  } finally { await f.close(); }
});

test("zero rows and missing runId cannot be marked complete", async () => {
  for (const result of [{ runId: "empty", output: { counts: { naverOverall: 0 } } }, {}]) {
    const f = await fixture({ runCrawler: async () => result,
      inspectResult: () => ({ status: "complete", counts: {} }) });
    try {
      await f.scheduler.tick();
      assert.ok((await f.scheduler.status()).items.every((item) => item.status === "failed"));
    } finally { await f.close(); }
  }
});

test("verified main blocking from quality gate stops the rest", async () => {
  const f = await fixture({ inspectResult: () => ({ status: "blocked", blockedReason: "main_captcha", counts: {} }) });
  try {
    await f.scheduler.tick();
    assert.equal(f.calls.length, 1);
    assert.equal((await f.scheduler.status()).blockedReason, "main_captcha");
  } finally { await f.close(); }
});

test("configuration is reread between jobs and disabled takes effect", async () => {
  let f;
  let count = 0;
  f = await fixture({ runCrawler: async () => {
    count += 1;
    await f.writeConfig({ ...f.config, enabled: false });
    return { runId: "first" };
  } });
  try {
    await f.scheduler.tick();
    assert.equal(count, 1);
    assert.equal((await f.scheduler.status()).enabled, false);
  } finally { await f.close(); }
});

test("a state write failure never starts an unrecorded crawl", async () => {
  const f = await fixture({ fs: { ...fs, writeFile: async () => { throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); } } });
  try {
    await f.scheduler.tick();
    assert.equal(f.calls.length, 0);
    assert.equal((await f.scheduler.status()).enabled, false);
  } finally { await f.close(); }
});

test("failed completion persistence cannot advance to the next keyword on a later tick", async () => {
  let writes = 0;
  let denyCompletionWrite = true;
  const f = await fixture({ fs: { ...fs, writeFile: async (...args) => {
    writes += 1;
    if (writes === 3 && denyCompletionWrite) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    return fs.writeFile(...args);
  } } });
  try {
    await f.scheduler.tick();
    assert.equal(f.calls.length, 1);
    denyCompletionWrite = false;
    await f.scheduler.tick();
    assert.equal(f.calls.length, 1);
    assert.match((await f.scheduler.status()).blockedReason, /state_persistence_failed/);
  } finally { await f.close(); }
});

test("stop suppresses the next job and timers are unref'd and cleared", async () => {
  let f;
  let count = 0;
  let unrefs = 0;
  let clears = 0;
  f = await fixture({
    runCrawler: async () => { count += 1; f.scheduler.stop(); return { runId: "first" }; },
    setTimeout: () => ({ unref: () => { unrefs += 1; } }),
    clearTimeout: () => { clears += 1; }
  });
  try {
    const promise = f.scheduler.start();
    assert.equal(typeof promise.then, "function");
    await promise;
    assert.equal(unrefs, 1);
    await f.scheduler.tick();
    assert.equal(count, 1);
    assert.equal(clears, 1);
  } finally { await f.close(); }
});

async function main() {
  for (const { name, fn } of cases) {
    await fn();
    console.log(`PASS ${name}`);
  }
  console.log(`${cases.length} daily keyword collection scheduler tests passed.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
