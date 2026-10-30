"use strict";
// Independent derived-work connection. No collector, provider, KOSIS or source
// writer is imported. A failed refresh never changes a collection/DB receipt.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { readBundleFile } = require("./keyword_monthly_bundle.cjs");
const { createKeywordMonthlyRefresh } = require("./keyword_monthly_refresh.cjs");
const { refreshKeywordMonthlyFromCompletedRun } = require("../refresh_keyword_monthly_from_completed_run.cjs");
const { pruneKeywordMonthlyRefreshGenerations } = require("./keyword_monthly_refresh_retention.cjs");
const RUN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/, SHA = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeCode = e => /^KEYWORD_[A-Z0-9_]{1,120}$/.test(e?.code || "") ? e.code : "KEYWORD_REFRESH_INTEGRATION_UNAVAILABLE";
const iso = v => typeof v === "string" && /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) && Number.isFinite(Date.parse(v));
const keyword = v => typeof v === "string" && v === v.trim() && v.length > 0 && v.length <= 300 && !/[\u0000-\u001f\u007f]/.test(v);
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
async function readJson(file, max) { const r = await readBundleFile(file, max); try { return { ...r, value: JSON.parse(r.bytes) }; } catch { fail("KEYWORD_REFRESH_EVIDENCE_JSON"); } }
function holdActive(value, day) {
  if (!value) return false;
  if (typeof value !== "object" || typeof value.holdThrough !== "string" || !/^20\d\d-\d\d-\d\d$/.test(value.holdThrough)) return true;
  const time = Date.parse(value.holdThrough + "T00:00:00Z");
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value.holdThrough) return true;
  return value.holdThrough >= day;
}
async function readStoredCollectionAdmission(dataDir, at = new Date().toISOString()) {
  const day = new Date(Date.parse(at) + 9 * 3600000).toISOString().slice(0, 10);
  const rows = [
    ["collector/jobs.json", 16 * 1024 * 1024, true],
    ["collector-scheduled/jobs.json", 16 * 1024 * 1024, true],
    ["collector-web/state.json", 1024 * 1024, false]
  ];
  try {
    for (const [relative, max, broker] of rows) {
      const s = (await readJson(path.join(dataDir, relative), max)).value;
      if (!s || typeof s !== "object" || s.version !== 1) return { allowed: false, reasonCode: "KEYWORD_REFRESH_GUARD_UNKNOWN" };
      if (!Object.hasOwn(s, "halted") || s.halted !== null && (!s.halted || typeof s.halted !== "object" || Array.isArray(s.halted))) return { allowed: false, reasonCode: "KEYWORD_REFRESH_GUARD_UNKNOWN" };
      if (s.halted || holdActive(s.reviewHold, day)) return { allowed: false, reasonCode: "KEYWORD_REFRESH_COLLECTION_PROTECTED" };
      if (broker) {
        if (!Array.isArray(s.jobs)) return { allowed: false, reasonCode: "KEYWORD_REFRESH_GUARD_UNKNOWN" };
        if (s.jobs.some(j => !j || !["queued", "leased", "committing", "completed", "failed", "cancelled", "interrupted"].includes(j.status))) return { allowed: false, reasonCode: "KEYWORD_REFRESH_GUARD_UNKNOWN" };
        if (s.jobs.some(j => ["queued", "leased", "committing"].includes(j?.status))) return { allowed: false, reasonCode: "KEYWORD_REFRESH_COLLECTION_BUSY" };
      } else {
        if (!Object.hasOwn(s, "active") || s.active !== null && (!s.active || typeof s.active !== "object" || Array.isArray(s.active))) return { allowed: false, reasonCode: "KEYWORD_REFRESH_GUARD_UNKNOWN" };
        if (s.active) return { allowed: false, reasonCode: "KEYWORD_REFRESH_COLLECTION_BUSY" };
      }
    }
    return { allowed: true, reasonCode: null };
  } catch { return { allowed: false, reasonCode: "KEYWORD_REFRESH_GUARD_UNREADABLE" }; }
}
async function readCompletedKeywordEvidence({ dataDir, intent, readPostprocess, allowsDerivedUpdates }) {
  if (!intent || !RUN.test(intent.runId || "") || !keyword(intent.keyword) || !SHA.test(intent.manifestSha256 || "")) fail("KEYWORD_REFRESH_INPUT_INVALID");
  const r = await readJson(path.join(dataDir, "outputs", intent.runId, "manifest.json"), 1024 * 1024), m = r.value;
  if (r.sha256 !== intent.manifestSha256 || m.keyword !== intent.keyword || m.runId && m.runId !== intent.runId) fail("KEYWORD_REFRESH_COMPLETED_EVIDENCE_CHANGED");
  if (m.searchMode === "company") fail("KEYWORD_REFRESH_NOT_KEYWORD_COLLECTION");
  if (m.collectionQuality?.status !== "complete" || !allowsDerivedUpdates(m)) fail("KEYWORD_REFRESH_COLLECTION_NOT_COMPLETE");
  const row = await readPostprocess(intent.runId);
  if (!row || row.runId !== intent.runId) return { status: "waiting", reasonCode: "KEYWORD_REFRESH_DB_RECEIPT_MISSING" };
  if ((row.scheduleOccurrenceId || null) !== (intent.scheduleOccurrenceId || null)) fail("KEYWORD_REFRESH_DB_IDENTITY_CHANGED");
  if (["failed", "held"].includes(row.status || row.state)) fail("KEYWORD_REFRESH_DB_NOT_COMPLETE");
  if ((row.status || row.state) !== "complete") return { status: "waiting", reasonCode: "KEYWORD_REFRESH_DB_POSTPROCESS_PENDING" };
  if (!SHA.test(row.result?.sourceManifestSha256 || "")) fail("KEYWORD_REFRESH_DB_MANIFEST_HASH_UNKNOWN");
  if (row.result.sourceManifestSha256 !== intent.manifestSha256) fail("KEYWORD_REFRESH_DB_MANIFEST_HASH_CHANGED");
  if (!iso(row.finishedAt)) fail("KEYWORD_REFRESH_DB_TIME_UNKNOWN");
  return { runId: intent.runId, keyword: intent.keyword, manifestSha256: r.sha256, scheduleOccurrenceId: intent.scheduleOccurrenceId || null,
    status: "complete", quality: "complete", postprocessStatus: "complete", finishedAt: row.finishedAt,
    collectionFinishedAt: m.completedAt || m.collectedAt || null, checkIn: m.checkIn, checkOut: m.checkOut,
    bookingRangeDays: m.bookingRangeDays, searchMode: m.searchMode || "keyword" };
}
function createKeywordMonthlyRefreshIntegration(options = {}) {
  const { dataDir, codeRoot, outputsDir = path.join(dataDir || "/", "outputs"), readPostprocess, readPostprocessList, allowsDerivedUpdates,
    isCollectionIdle = () => false, runWork, now = () => new Date(), logger = console,
    assertAnalyticalLeaseHeld = () => false,
    createQueue = createKeywordMonthlyRefresh, refresh = refreshKeywordMonthlyFromCompletedRun,
    setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = options;
  if (!path.isAbsolute(dataDir || "") || !path.isAbsolute(codeRoot || "") || [readPostprocess, readPostprocessList, allowsDerivedUpdates, runWork].some(f => typeof f !== "function")) throw new TypeError("Keyword refresh requires explicit source and application callbacks");
  const namespaceSupported = path.resolve(outputsDir) === path.join(dataDir, "outputs");
  let timer = null, reconciling = null, closed = false, cleanup = null;
  const clock = () => new Date(now()).toISOString();
  const report = (tag, e) => logger.error?.(tag, safeCode(e));
  async function admission() {
    if (!namespaceSupported) return { allowed: false, reasonCode: "KEYWORD_REFRESH_OUTPUT_NAMESPACE_UNSUPPORTED" };
    if (closed || !isCollectionIdle()) return { allowed: false, reasonCode: "KEYWORD_REFRESH_COLLECTION_BUSY" };
    return readStoredCollectionAdmission(dataDir, clock());
  }
  const queue = createQueue({ dataDir,
    readCompletedEvidence: intent => readCompletedKeywordEvidence({ dataDir, intent, readPostprocess, allowsDerivedUpdates }),
    canProcess: admission, idleIntervalMs: 30000,
    refresh: (evidence, intent, work = {}) => runWork(async () => {
      const before = await admission(); if (!before.allowed) throw Object.assign(new Error(before.reasonCode), { code: before.reasonCode, deferred: true });
      const controller = new AbortController();
      const aborted = () => controller.abort();
      if (work.signal?.aborted) controller.abort(); else work.signal?.addEventListener("abort", aborted, { once: true });
      const watch = setIntervalImpl(() => { if (closed || !isCollectionIdle()) controller.abort(); }, 1000); watch?.unref?.();
      try {
        const result = await refresh({ dataDir, codeRoot, scratchParent: path.resolve(require("node:os").tmpdir()), mode: "live",
        evidence, now: clock(), signal: controller.signal,
        canPublish: async () => { const gate = await admission(); return gate.allowed; } });
        if (["published", "unchanged", "complete"].includes(result?.status) && SHA.test(result.pointerSha256 || "")) {
          try {
            await pruneKeywordMonthlyRefreshGenerations({ projectionDir: path.join(dataDir, "keyword_monthly_analysis"),
              expectedCurrentPointerSha256: result.pointerSha256, keepSuccessfulAuto: 2, assertLeaseHeld: assertAnalyticalLeaseHeld });
            cleanup = { status: "complete", observedAt: clock(), reasonCode: null };
          } catch (e) { cleanup = { status: "needs_verification", observedAt: clock(), reasonCode: safeCode(e) }; report("keyword_monthly_refresh_cleanup_failed", e); }
        }
        return result;
      }
      finally { clearIntervalImpl(watch); work.signal?.removeEventListener("abort", aborted); }
    }, { priority: "background", kind: "keyword_monthly_refresh" }), now
  });
  async function signalCompletedRun(runId, context) {
    try {
      if (!namespaceSupported) return { status: "needs_verification", errorCode: "KEYWORD_REFRESH_OUTPUT_NAMESPACE_UNSUPPORTED" };
      const name = context?.historyPayload?.keyword || context?.plan?.keyword;
      if (!RUN.test(runId || "") || !keyword(name) || !SHA.test(context?.manifestSha256 || "")) return { status: "skipped", reasonCode: "KEYWORD_REFRESH_SOURCE_IDENTITY_UNKNOWN" };
      if ((context.historyPayload?.searchMode || context.plan?.searchMode) === "company") return { status: "skipped", reasonCode: "KEYWORD_REFRESH_NOT_KEYWORD_COLLECTION" };
      return await queue.enqueue({ runId, keyword: name, manifestSha256: context.manifestSha256,
        scheduleOccurrenceId: context.scheduleOccurrenceId || null });
    } catch (e) { report("keyword_monthly_refresh_signal_failed", e); return { status: "needs_verification", errorCode: safeCode(e) }; }
  }
  async function reconcile() {
    if (closed) return;
    if (reconciling) return reconciling;
    reconciling = (async () => {
      const status = await queue.status(), activatedAt = status.activatedAt;
      if (!iso(activatedAt)) return;
      const snapshot = await readPostprocessList();
      if (!Array.isArray(snapshot?.items)) fail("KEYWORD_REFRESH_DB_INDEX_UNKNOWN");
      for (const row of snapshot.items.slice(0, 1024)) {
        if ((row.status || row.state) !== "complete" || !RUN.test(row.runId || "") || !iso(row.finishedAt) || Date.parse(row.finishedAt) < Date.parse(activatedAt)) continue;
        const r = await readJson(path.join(dataDir, "outputs", row.runId, "manifest.json"), 1024 * 1024), m = r.value;
        if (!keyword(m.keyword) || m.searchMode === "company" || m.collectionQuality?.status !== "complete" || !allowsDerivedUpdates(m)) continue;
        await queue.enqueue({ runId: row.runId, keyword: m.keyword, manifestSha256: r.sha256, scheduleOccurrenceId: row.scheduleOccurrenceId || null });
      }
    })().catch(e => report("keyword_monthly_refresh_reconcile_failed", e)).finally(() => { reconciling = null; });
    return reconciling;
  }
  async function start() {
    if (!namespaceSupported) return { status: "needs_verification", errorCode: "KEYWORD_REFRESH_OUTPUT_NAMESPACE_UNSUPPORTED" };
    await queue.start(); await reconcile();
    if (!closed && !timer) { timer = setIntervalImpl(() => { void reconcile(); }, 30000); timer?.unref?.(); }
    return queue.status();
  }
  async function close() { closed = true; if (timer) clearIntervalImpl(timer); timer = null; await queue.close(); if (reconciling) await reconciling; }
  return { start, close, signalCompletedRun, reconcile, status: async () => namespaceSupported ? { ...(await queue.status()), cleanup }
    : { status: "needs_verification", readOnly: true, errorCode: "KEYWORD_REFRESH_OUTPUT_NAMESPACE_UNSUPPORTED", counts: null, items: null }, runOnce: () => queue.runOnce() };
}
module.exports = { createKeywordMonthlyRefreshIntegration, readCompletedKeywordEvidence, readStoredCollectionAdmission, holdActive };
