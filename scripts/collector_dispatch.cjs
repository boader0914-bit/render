const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const ENV_KEYS = [
  "CHECK_IN", "CHECK_OUT", "ADULTS", "SEARCH_MODE", "SEARCH_MODE_REQUESTED", "SEARCH_MODE_AUTO_CORRECTED",
  "SEARCH_INTENT", "SEARCH_REGION", "SEARCH_SCOPE", "SEARCH_SCOPE_LABEL", "COLLECTION_MODE", "COLLECTION_PURPOSE",
  "DETAIL_RANK_RANGES", "PRODUCT_MODE", "BOOKING_RANGE_DAYS", "BOOKING_RANGE_PLACE_LIMIT", "NAVER_BOOKING_STOCK_LIMIT",
  "SOURCE_ROLE", "COLLECTION_SOURCE", "COLLECTION_SOURCE_LABEL", "SCHEDULED_COLLECTION",
  "NAVER_REQUEST_PACING_ENABLED", "NAVER_REQUEST_MIN_INTERVAL_MS", "NAVER_REQUEST_MAX_CONCURRENCY",
  "NAVER_REQUEST_PACING_START_DATE", "NAVER_BOOKING_DETAIL_CONCURRENCY", "NAVER_SCHEDULE_CONCURRENCY",
  "NAVER_OTA_OBSERVATION_CONCURRENCY", "NAVER_SCHEDULE_DELAY_MS", "NAVER_OTA_OBSERVATION_LIMIT",
  "NAVER_BOOKING_ID_FALLBACK", "NAVER_COUPON_PAGE_FALLBACK", "REGIONAL_LIMIT", "REGIONAL_SEARCH_CONCURRENCY", "RUN_STAMP"
];

function collectionEnv(env) {
  return Object.fromEntries(ENV_KEYS.filter(key => env[key] !== undefined).map(key => [key, String(env[key])]));
}

function workerError(code, cancelled = false) {
  const error = new Error(cancelled ? "수집이 중지되었습니다." : "수집 워커 연결 또는 작업 상태를 확인해야 합니다. 자동 재수집하지 않습니다.");
  error.code = code;
  error.statusCode = cancelled ? 499 : 503;
  error.cancelled = cancelled;
  return error;
}

// This is dispatch only: an unavailable worker must never fall back to local crawling.
async function dispatchCollector({ broker, keyword, env, payload, context, onJob = () => {}, isCancelled = () => false,
  pollMs = 500, queuedTimeoutMs = 120000, timeoutMs = 12 * 60 * 60 * 1000, now = Date.now, sleep = delay }) {
  let job;
  try { job = await broker.submit({ keyword, env: collectionEnv(env), payload, context }); }
  catch { throw workerError("COLLECTOR_WORKER_UNAVAILABLE"); }
  onJob(job.id);
  const started = now();
  let cancellationSent = false;
  for (;;) {
    if (isCancelled() && !cancellationSent) {
      await broker.cancel(job.id);
      cancellationSent = true;
    }
    job = await broker.getJob(job.id);
    if (!job) throw workerError("COLLECTOR_WORKER_STATE_LOST");
    if (TERMINAL.has(job.status)) {
      if (job.status === "completed" && !isCancelled()) return job;
      const cancelled = job.status === "cancelled" || isCancelled();
      throw workerError(cancelled ? "CRAWL_CANCELLED" : "COLLECTOR_WORKER_INTERRUPTED", cancelled);
    }
    if ((job.status === "queued" && now() - started > queuedTimeoutMs) || now() - started > timeoutMs) {
      await broker.cancel(job.id);
      await broker.halt("COLLECTOR_WORKER_TIMEOUT");
      throw workerError("COLLECTOR_WORKER_UNAVAILABLE");
    }
    await sleep(pollMs);
  }
}

// Preserve the crawler's historical booking-ID fallback without sending the source CSVs,
// administrator data, corrections, cookies, API keys, or the existing result archive.
function createHistoricalBookingContext({ outputsDir, parseCsv }) {
  const cached = new Map();
  return async () => {
    let entries;
    try { entries = await fs.readdir(outputsDir, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return { historicalBookingBusinesses: [] }; throw error; }
    const map = new Map();
    const current = new Set();
    for (const entry of entries.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = path.join(outputsDir, entry.name);
      const names = await fs.readdir(dir);
      const name = names.find(name => name.endsWith("_네이버전체순위.csv"));
      if (!name) continue;
      const file = path.join(dir, name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      current.add(file);
      const signature = `${stat.size}:${stat.mtimeMs}`;
      let item = cached.get(file);
      if (!item || item.signature !== signature) {
        const rows = parseCsv((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
        const ids = rows.flatMap(row => {
          const placeId = String(row.place_id || "").trim();
          const businessId = String(row["네이버예약사업자ID"] || "").trim();
          return /^[1-9][0-9]{0,19}$/.test(placeId) && /^[1-9][0-9]{0,19}$/.test(businessId) ? [{ placeId, businessId }] : [];
        });
        cached.set(file, item = { signature, ids });
      }
      for (const row of item.ids) map.set(row.placeId, row);
    }
    for (const file of cached.keys()) if (!current.has(file)) cached.delete(file);
    const historicalBookingBusinesses = [...map.values()];
    if (Buffer.byteLength(JSON.stringify({ historicalBookingBusinesses })) > 900000) throw workerError("COLLECTOR_CONTEXT_TOO_LARGE");
    return { historicalBookingBusinesses };
  };
}

module.exports = { collectionEnv, dispatchCollector, createHistoricalBookingContext };
