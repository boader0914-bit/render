"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { COLLECTOR_PROGRESS_PREFIX, sanitizeCollectionProgress, parseCollectionProgressLine, createCollectionProgressReporter } = require("./collection_progress.cjs");
const NOW = "2026-09-24T08:00:00.000Z";
const valid = { version: 1, phase: "inventory", completedPlaces: 1, totalPlaces: 3, currentPlaceName: "검증 글램핑", updatedAt: NOW };

test("progress wire format validates counts/time and strips unrelated fields and name controls", () => {
  const sanitized = sanitizeCollectionProgress({ ...valid, secret: "not forwarded", currentPlaceName: `검증\n\u001b글램핑 ${"가".repeat(150)}` });
  assert.equal(sanitized.currentPlaceName.length, 120);
  assert.equal(sanitized.currentPlaceName.includes("\n"), false);
  assert.equal(Object.hasOwn(sanitized, "secret"), false);
  assert.deepEqual(parseCollectionProgressLine(`${COLLECTOR_PROGRESS_PREFIX}${JSON.stringify(valid)}\r\n`), valid);
  for (const change of [
    { version: 2 }, { phase: "complete" }, { completedPlaces: -1 }, { completedPlaces: 4 },
    { completedPlaces: 1.5 }, { completedPlaces: "1" }, { totalPlaces: null }, { totalPlaces: Infinity },
    { currentPlaceName: {} }, { updatedAt: "yesterday" }, { updatedAt: "2026-02-30T08:00:00.000Z" },
  ]) assert.equal(sanitizeCollectionProgress({ ...valid, ...change }), null);
  for (const line of [null, "inventory 1/3", `${COLLECTOR_PROGRESS_PREFIX}{broken`, `noise ${COLLECTOR_PROGRESS_PREFIX}${JSON.stringify(valid)}`, `${COLLECTOR_PROGRESS_PREFIX}${" ".repeat(4096)}`]) {
    assert.equal(parseCollectionProgressLine(line), null);
  }
});

test("reporter measures unique finished places in completion order without implying whole-job success", () => {
  const lines = [];
  const reporter = createCollectionProgressReporter({ totalPlaces: 2, write: line => lines.push(line), now: () => NOW });
  assert.equal(reporter.completePlace("unknown"), false);
  reporter.start();
  reporter.start();
  assert.equal(lines.length, 1);
  assert.equal(reporter.startPlace("a", "가 업체"), true);
  assert.equal(reporter.startPlace("a", "중복 업체"), false);
  assert.equal(reporter.startPlace("b", "나 업체"), true);
  assert.equal(reporter.startPlace("c", "범위 밖"), false);
  reporter.completePlace("b");
  assert.equal(reporter.snapshot().currentPlaceName, "가 업체");
  assert.equal(reporter.completePlace("b"), false);
  reporter.completePlace("a");
  assert.deepEqual(lines.map(parseCollectionProgressLine).map(row => row.completedPlaces), [0, 0, 0, 1, 2]);
  assert.deepEqual(reporter.snapshot(), { ...valid, completedPlaces: 2, totalPlaces: 2, currentPlaceName: "" });
  assert.equal(Object.hasOwn(reporter.snapshot(), "status"), false);
  const empty = createCollectionProgressReporter({ totalPlaces: 0, write: () => {}, now: () => NOW });
  assert.equal(empty.start().completedPlaces, 0);
  assert.equal(empty.startPlace("a", "없음"), false);
  const unwritable = createCollectionProgressReporter({ totalPlaces: 1, write: () => { throw new Error("closed sink"); }, now: () => NOW });
  assert.doesNotThrow(() => { unwritable.start(); unwritable.startPlace("a"); unwritable.completePlace("a"); });
});

const crawler = fs.readFileSync(path.join(__dirname, "gyeongnam_glamping_crawl.cjs"), "utf8");
function sourceFunction(name) {
  const start = crawler.indexOf(`async function ${name}(`);
  assert.ok(start >= 0);
  const next = /\n(?:async )?function /.exec(crawler.slice(start + 1));
  return crawler.slice(start, next ? start + 1 + next.index : crawler.length);
}
function harness({ collect, concurrency = 2, mode = "precision", limit = 5 } = {}) {
  const events = [];
  const calls = [];
  const context = {
    DAY_USE_MODE: "inspect", COLLECTION_MODE: mode, COLLECTION_PURPOSE: "revenue_detail",
    DETAIL_RANK_RANGES: [{ start: 1, end: 5 }], DETAIL_RANK_RANGE_LABEL: "1-5",
    NAVER_BOOKING_STOCK_LIMIT: limit, NAVER_BOOKING_DETAIL_CONCURRENCY: concurrency,
    COLLECTION_PROFILE: { collectWeeklyRange: true }, BOOKING_RANGE_DAYS: 31, BOOKING_RANGE_PLACE_LIMIT: 5,
    GUARDED_COLLECTION: true, naverScheduleBlockedStatus: 0, naverRequestBlockedStatus: 0,
    asNumber: value => Number(value) || 0, rankInRanges: rank => rank >= 1 && rank <= 5,
    jsonCell: async value => JSON.stringify(value), formatWon: value => `${value}원`, setNaverInventoryAuditFields: () => {},
    createCollectionProgressReporter: options => createCollectionProgressReporter({ ...options, now: () => NOW, write: line => events.push(parseCollectionProgressLine(line)) }),
    collectNaverBookingAvailability: async (placeId, _cache, options) => {
      if (context.naverScheduleBlockedStatus || context.naverRequestBlockedStatus) throw new Error("NAVER_SCHEDULE_BLOCKED");
      calls.push({ placeId, options });
      return collect ? collect(placeId, context) : { status: "성공" };
    },
  };
  const enrich = vm.runInNewContext(`${sourceFunction("mapWithConcurrency")}\n${sourceFunction("enrichNaverRowsWithBookingAvailability")}\nenrichNaverRowsWithBookingAvailability`, context);
  return { enrich, events, calls, context };
}
const row = (placeId, rank = 1, fields = {}) => ({ place_id: placeId, 예약: "Y", overall_rank: rank, 업체명: `검증업체 ${placeId}`, ...fields });

test("crawler reports actual eligible unique targets and completion after each async place finishes", async () => {
  const pending = new Map();
  const h = harness({ collect: placeId => new Promise(resolve => pending.set(placeId, resolve)) });
  const rows = [row("a"), row("b", 2), row("a"), row("outside", 20), row("no-booking", 3, { 예약: "N" }), row("", 4)];
  const finished = h.enrich(rows);
  assert.equal(h.events[0].completedPlaces, 0);
  assert.equal(h.events[0].totalPlaces, 2);
  assert.equal(h.events.at(-1).completedPlaces, 0);
  pending.get("b")({ status: "성공" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.events.at(-1).completedPlaces, 1);
  assert.equal(h.events.at(-1).currentPlaceName, "검증업체 a");
  pending.get("a")({ status: "성공" });
  const summary = await finished;
  assert.deepEqual(h.calls.map(call => call.placeId), ["a", "b"]);
  assert.equal(summary.successful, 2);
  assert.equal(h.events.at(-1).completedPlaces, 2);
  assert.equal(h.events.at(-1).totalPlaces, 2);
  assert.equal(h.events.at(-1).currentPlaceName, "");
  assert.ok(h.calls.every(call => call.options.collectRange), "progress does not change the requested date range");
});

test("crawler counts a processed failure while preserving quality and excludes unstarted blocked work", async () => {
  const failure = harness({ collect: async placeId => { if (placeId === "b") throw new Error("timeout"); return { status: "성공" }; } });
  const failedRows = [row("a"), row("b", 2)];
  const summary = await failure.enrich(failedRows);
  assert.equal(summary.successful, 1);
  assert.equal(failure.events.at(-1).completedPlaces, 2);
  assert.match(failedRows[1].네이버예약재고수집상태, /실패: timeout/);

  const blocked = harness({ concurrency: 1, collect: async (_placeId, context) => {
    context.naverRequestBlockedStatus = 429;
    throw new Error("NAVER_REQUEST_BLOCKED");
  } });
  const blockedRows = [row("a"), row("b", 2), row("c", 3)];
  const blockedSummary = await blocked.enrich(blockedRows);
  assert.deepEqual(blocked.calls.map(call => call.placeId), ["a"], "no new provider work after the guard closes");
  assert.equal(blockedSummary.successful, 0);
  assert.equal(blocked.events.at(-1).completedPlaces, 1);
  assert.equal(blocked.events.at(-1).totalPlaces, 3);
  assert.ok(blockedRows.every(item => item.네이버예약재고수집상태.startsWith("실패:")));
});

test("crawler excludes mode/rank/limit skips from its progress denominator", async () => {
  const limited = harness({ limit: 1 });
  await limited.enrich([row("a"), row("b", 2), row("rank-skip", 6)]);
  assert.equal(limited.events.at(-1).totalPlaces, 1);
  assert.equal(limited.events.at(-1).completedPlaces, 1);
  const fast = harness({ mode: "fast" });
  await fast.enrich([row("a"), row("b", 2)]);
  assert.equal(fast.calls.length, 0);
  assert.equal(fast.events.length, 1);
  assert.equal(fast.events[0].totalPlaces, 0);
  assert.equal(fast.events[0].completedPlaces, 0);
});
