const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { compareDailyCollection, parseArgs } = require("./compare_daily_collection.cjs");
const { KEYWORDS } = require("./daily_keyword_collection_scheduler.cjs");

const cases = [];
function test(name, run) { cases.push({ name, run }); }
const dates = { baseline: "2026-09-21", trial: "2026-09-22" };

function manifest(date, keyword) {
  const end = new Date(`${date}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 30);
  return { keyword, checkIn: date, checkOut: end.toISOString().slice(0, 10),
    searchMode: "keyword", collectionMode: "precision", collectionPurpose: "revenue_detail",
    productMode: "all", detailRankRanges: "1-20", bookingRangeDays: 31, bookingRangePlaceLimit: 20,
    scheduledCollection: true, naverAttemptedQueries: [{ status: 200 }],
    counts: { naverOverall: 20, naverBookingStockChecked: 20, naverBookingStockSucceeded: 20,
      naverOtaObservationChecked: 20, naverOtaBlocked: 0, naverOtaFailed: 0,
      naverScheduleRequested: 310, naverScheduleSucceeded: 310, naverScheduleFailed: 0, naverScheduleBlocked: 0 } };
}

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "staydatalab-comparison-test-"));
  const state = { version: 1, days: {} };
  const manifests = new Map();
  for (const [label, date] of Object.entries(dates)) {
    const duration = label === "baseline" ? 1000 : 1500;
    const start = Date.parse(`${date}T05:00:00Z`);
    const items = KEYWORDS.map((keyword, index) => {
      const runId = `${date.replaceAll("-", "")}_${index}`;
      manifests.set(runId, manifest(date, keyword));
      return { keyword, runId, status: "completed", quality: { status: "complete" },
        startedAt: new Date(start + index * (duration + 100)).toISOString(),
        endedAt: new Date(start + index * (duration + 100) + duration).toISOString(), durationMs: duration };
    });
    state.days[date] = { day: date, items, createdAt: new Date(start - 100).toISOString(),
      finishedAt: new Date(start + 13 * duration + 12 * 100 + 200).toISOString(), lastFreeBytes: 500000000 };
  }
  async function save() {
    await fs.mkdir(path.join(dataDir, "history"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "history", "daily_keyword_collection_state.json"), JSON.stringify(state));
    for (const [runId, value] of manifests) {
      await fs.mkdir(path.join(dataDir, "outputs", runId), { recursive: true });
      await fs.writeFile(path.join(dataDir, "outputs", runId, "manifest.json"), JSON.stringify(value));
    }
  }
  return { dataDir, state, manifests, save, compare: () => compareDailyCollection({ dataDir, ...dates }),
    close: async () => {
      assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
      await fs.rm(dataDir, { recursive: true, force: true });
    } };
}

test("compares all thirteen same-scope verified runs and separates wall from item durations", async () => {
  const f = await fixture();
  try {
    await f.save();
    const result = await f.compare();
    assert.equal(result.baseline.status, "completed");
    assert.equal(result.baseline.summedDurationMs, 13000);
    assert.equal(result.baseline.wallMs, 14400);
    assert.equal(result.trial.summedDurationMs, 19500);
    assert.equal(result.comparison.allComparable, true);
    assert.equal(result.comparison.wallDeltaMs, 6500);
    assert.equal(result.comparison.items[0].changePercent, 50);
    assert.equal(result.baseline.countsFromManifests.naverScheduleRequested.total, 4030);
    assert.equal(result.baseline.countsFromManifests.naverScheduleRequested.manifests, 13);
    assert.equal(result.scopes.length, 1);
    assert.equal(result.baseline.items[0].codeVersion, null);
    assert.equal(result.baseline.actualNaverRequests.total, null);
    assert.match(result.interpretation.causality, /does not prove/);
  } finally { await f.close(); }
});

test("missing tomorrow is pending, never completed or a zero-second successful run", async () => {
  const f = await fixture();
  try {
    delete f.state.days[dates.trial];
    await f.save();
    const result = await f.compare();
    assert.equal(result.trial.status, "not_started");
    assert.equal(result.trial.counts.pending, 13);
    assert.equal(result.trial.allTerminal, false);
    assert.equal(result.trial.wallMs, null);
    assert.equal(result.trial.summedDurationMs, null);
    assert.equal(result.comparison.wallDeltaMs, null);
    assert.equal(result.comparison.comparableKeywords, 0);
  } finally { await f.close(); }
});

test("partial, failed, blocked, interrupted and running cannot yield misleading full-day deltas", async () => {
  const f = await fixture();
  try {
    const day = f.state.days[dates.trial];
    ["partial", "failed", "blocked", "interrupted", "running", "pending"].forEach((status, index) => {
      day.items[index].status = status;
      if (["running", "pending"].includes(status)) delete day.items[index].endedAt;
    });
    delete day.finishedAt;
    day.stoppedAt = day.items[3].endedAt;
    day.blockedReason = "naver_schedule_http_429";
    await f.save();
    const result = await f.compare();
    assert.equal(result.trial.status, "stopped");
    assert.equal(result.trial.counts.partial, 1);
    assert.equal(result.trial.counts.failed, 1);
    assert.equal(result.trial.counts.blocked, 1);
    assert.equal(result.trial.counts.interrupted, 1);
    assert.equal(result.trial.counts.running, 1);
    assert.equal(result.trial.counts.pending, 1);
    assert.equal(result.trial.blockedReason, "naver_schedule_http_429");
    assert.equal(result.trial.items[4].durationMs, null);
    assert.equal(result.trial.items[3].durationMs, null);
    assert.equal(result.comparison.comparableKeywords, 7);
    assert.equal(result.comparison.wallDeltaMs, null);
  } finally { await f.close(); }
});

test("complete ledger with missing or partial evidence stays unverified; changed scope is excluded", async () => {
  const f = await fixture();
  try {
    const day = f.state.days[dates.trial];
    f.manifests.delete(day.items[0].runId);
    const partial = f.manifests.get(day.items[1].runId);
    partial.counts.naverScheduleSucceeded = 309;
    partial.counts.naverScheduleFailed = 1;
    f.manifests.get(day.items[2].runId).detailRankRanges = "1-10";
    f.manifests.get(day.items[3].runId).checkIn = dates.baseline;
    await f.save();
    const result = await f.compare();
    assert.equal(result.trial.allTerminal, true);
    assert.equal(result.trial.status, "terminal_with_issues");
    assert.equal(result.trial.items[0].manifestStatus, "missing");
    assert.equal(result.trial.items[1].quality, "partial");
    assert.equal(result.comparison.items[2].reason, "scope_changed");
    assert.equal(result.comparison.items[3].deltaMs, null);
    assert.equal(result.trial.countsFromManifests.naverScheduleRequested.manifests, 12);
  } finally { await f.close(); }
});

test("reads only exact listed run manifests, whitelists diagnostics, and leaves all files unchanged", async () => {
  const f = await fixture();
  try {
    const trialItem = f.state.days[dates.trial].items[0];
    trialItem.error = "password=DO_NOT_EMIT_STATE";
    const selected = f.manifests.get(trialItem.runId);
    selected.requestPacing = { enabled: true, minIntervalMs: 200, maxConcurrentRequests: 2,
      detailConcurrency: 1, scheduleConcurrency: 2, otaConcurrency: 1,
      requestCount: 350, totalWaitMs: 10000, maxInFlight: 2, stopped: false,
      authorization: "DO_NOT_EMIT_MANIFEST", profile: "low_load", url: "https://token@server" };
    selected.gitCommit = "93ec340";
    f.manifests.set("unrelated_manual_run", { keyword: KEYWORDS[0], counts: { naverScheduleRequested: 999999 } });
    await f.save();
    const watched = [path.join(f.dataDir, "history", "daily_keyword_collection_state.json"),
      ...[...f.manifests.keys()].map((runId) => path.join(f.dataDir, "outputs", runId, "manifest.json"))];
    const before = await Promise.all(watched.map(async (file) => [await fs.readFile(file, "utf8"), (await fs.stat(file)).mtimeMs]));
    const result = await f.compare();
    const source = JSON.stringify(result);
    assert.equal(source.includes("DO_NOT_EMIT"), false);
    assert.equal(source.includes("token@server"), false);
    assert.equal(result.pacingProfiles[0].requestCount, 350);
    assert.equal(result.trial.actualNaverRequests.total, 350);
    assert.equal(result.trial.actualNaverRequests.manifests, 1);
    assert.equal(result.pacingProfiles[0].maxConcurrentRequests, 2);
    assert.equal(result.trial.items[0].codeVersion, "93ec340");
    assert.equal(result.trial.countsFromManifests.naverScheduleRequested.total, 4030);
    const after = await Promise.all(watched.map(async (file) => [await fs.readFile(file, "utf8"), (await fs.stat(file)).mtimeMs]));
    assert.deepEqual(after, before);
    const cli = spawnSync(process.execPath, [path.join(__dirname, "compare_daily_collection.cjs"), "--baseline", dates.baseline, "--trial", dates.trial, "--data-dir", f.dataDir], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).comparison.allComparable, true);
  } finally { await f.close(); }
});

test("disabled pacing does not report zero actual HTTP requests and new gate stop reasons remain exact", async () => {
  const f = await fixture();
  try {
    for (const value of f.manifests.values()) value.requestPacing = { enabled: false, requestCount: 0 };
    const day = f.state.days[dates.trial];
    day.blockedReason = "naver_request_http_429";
    await f.save();
    let result = await f.compare();
    assert.deepEqual(result.baseline.actualNaverRequests, { total: null, manifests: 0 });
    assert.deepEqual(result.trial.actualNaverRequests, { total: null, manifests: 0 });
    assert.equal(result.trial.blockedReason, "naver_request_http_429");
    day.blockedReason = "naver_request_http_403";
    await f.save();
    result = await f.compare();
    assert.equal(result.trial.blockedReason, "naver_request_http_403");
  } finally { await f.close(); }
});

test("rejects traversal, malformed dates/state and raw error disclosure", async () => {
  const f = await fixture();
  try {
    f.state.days[dates.trial].items[0].runId = "../secret";
    await f.save();
    const result = await f.compare();
    assert.equal(result.trial.items[0].manifestStatus, "invalid_run_id");
    assert.equal(result.trial.items[0].runId, null);
    await assert.rejects(compareDailyCollection({ dataDir: f.dataDir, baseline: "2026-02-30", trial: dates.trial }), /invalid_comparison_arguments/);
    await assert.rejects(compareDailyCollection({ dataDir: f.dataDir, baseline: dates.trial, trial: dates.baseline }), /invalid_comparison_arguments/);
    assert.throws(() => parseArgs(["--data-dir", "x", "--data-dir", "y"]), /invalid_comparison_arguments/);
    await fs.writeFile(path.join(f.dataDir, "history", "daily_keyword_collection_state.json"), "SECRET_BAD_JSON");
    const cli = spawnSync(process.execPath, [path.join(__dirname, "compare_daily_collection.cjs"), "--baseline", dates.baseline, "--trial", dates.trial, "--data-dir", f.dataDir], { encoding: "utf8" });
    assert.equal(cli.status, 1);
    assert.equal(cli.stdout, "");
    assert.equal(cli.stderr.includes("SECRET_BAD_JSON"), false);
    assert.equal(cli.stderr.includes(f.dataDir), false);
  } finally { await f.close(); }
});

(async () => {
  for (const { name, run } of cases) { await run(); console.log(`PASS ${name}`); }
  console.log(`${cases.length} daily collection comparison tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
