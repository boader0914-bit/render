"use strict";
// Narrow, one-shot dashboard release reader. Never calls the broader verifier's
// run/runtime path. No original rows, KOSIS paths, credentials, app or providers.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const P = require("./verify_keyword_monthly_production_preservation.cjs");
const ROOT = "/var/data", SOURCE = "/opt/render/project/src", SHA = /^[a-f0-9]{64}$/, GENERATION = /^[a-f0-9]{32}$/;
const MAX = Object.freeze({ db: 64 * 1024 * 1024, shm: 1024 * 1024, json: 2 * 1024 * 1024, broker: 8 * 1024 * 1024, output: 192 * 1024, brokerIds: 512 });
const hash = value => crypto.createHash("sha256").update(value).digest("hex"), count = value => Number.isSafeInteger(value) && value >= 0;
const need = (value, code) => { if (!value) throw Object.assign(Error(code), { code }); };
const dayValid = value => typeof value === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
const time = value => { if (value == null) return null; need(typeof value === "string" && value.length <= 40 && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), "DASHBOARD_TIME_INVALID"); return new Date(value).toISOString(); };
const code = value => { if (value == null || value === "") return null; need(typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(value), "DASHBOARD_CODE_INVALID"); return value; };
function fileSummary(record, root) { return { path: path.relative(root, record.file).split(path.sep).join("/"), bytes: record.bytes, sha256: record.sha256 }; }
function configJson(raw) { need(typeof raw === "string" && Buffer.byteLength(raw) <= 256 * 1024, "DASHBOARD_CONFIG_BOUNDS"); let value; try { value = JSON.parse(raw); } catch { need(false, "DASHBOARD_CONFIG_JSON"); } return P.configSummary(value); }
function sixSlot(config, revision) { return revision === 3 && config.enabled === true && config.keywordIntervalMinutes === 120 && config.time === "09:00" && config.workers.length === 2 && ["web", "manual"].every(key => config.workers.some(row => row.workerKey === key && row.dailyLimit === 3)); }
function guardFields(value) { return Object.fromEntries(["halted", "haltCode", "haltedAt", "reviewHoldPresent", "reviewHoldActive", "holdThrough"].map(key => [key, value[key]])); }
function captureSaved(options = {}, dependencies = {}) {
  const fixture = dependencies.fixture === true, root = fixture ? dependencies.root : ROOT, source = fixture ? dependencies.source : SOURCE;
  need(Object.keys(options).every(key => key === "now") && (fixture || process.platform === "linux" && process.cwd() === SOURCE), "WRONG_CENTRAL_SHELL_CONTEXT");
  const now = new Date(options.now ?? Date.now()); need(Number.isFinite(now.getTime()), "DASHBOARD_CLOCK_INVALID");
  const beganAt = now.toISOString(), day = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10), records = [];
  const read = fixture ? dependencies.read : P.read, checked = fixture ? dependencies.checked : P.checked, stable = fixture ? dependencies.stable : P.stable;
  need(typeof root === "string" && typeof source === "string" && [read, checked, stable].every(fn => typeof fn === "function"), "DASHBOARD_FIXTURE_INVALID");
  const saved = (relative, maximum = MAX.json) => { need(!path.isAbsolute(relative) && !relative.split("/").includes(".."), "UNSAFE_RELATIVE_PATH"); const record = read(path.join(root, relative), maximum); records.push(record); return record; };
  const schedule = ["config/daily_keyword_collection.json", "config/keyword-worker-schedule-manual.json", "config/keyword-worker-schedule-web.json"].map(relative => saved(relative));
  const brokers = ["collector/jobs.json", "collector-scheduled/jobs.json"].map(relative => { const record = saved(relative, MAX.broker), summary = P.brokerSummary(record.data, day), ids = record.data.jobs.map(row => row.id).sort(); return { ...summary, ledger: fileSummary(record, root), jobIds: ids.slice(0, MAX.brokerIds), jobIdsComplete: ids.length <= MAX.brokerIds, jobIdentitySha256: hash(JSON.stringify(ids)) }; });
  const webRead = saved("collector-web/state.json"), webCollector = { ...P.webSummary(webRead.data, day), ledger: fileSummary(webRead, root) };
  const postprocessRead = saved("history/collection_postprocess/queue.json"), postprocess = { ...P.queueSummary(postprocessRead.data), ledger: fileSummary(postprocessRead, root) };
  const pointerRead = saved("keyword_monthly_analysis/current.json", 16384), pointer = pointerRead.data;
  need(pointer?.schemaVersion === 1 && GENERATION.test(pointer.generation || "") && SHA.test(pointer.catalogSha256 || "") && count(pointer.catalogBytes) && pointer.catalogBytes > 0 && pointer.catalogBytes <= 1024 * 1024 && time(pointer.publishedAt), "DASHBOARD_POINTER_INVALID");
  const catalogRead = saved(`keyword_monthly_analysis/generations/${pointer.generation}/catalog.json`, 1024 * 1024);
  need(catalogRead.sha256 === pointer.catalogSha256 && catalogRead.bytes === pointer.catalogBytes && catalogRead.data?.schemaVersion === 1 && catalogRead.data.kind === "keyword_monthly_partition_bundle" && Array.isArray(catalogRead.data.scopes), "DASHBOARD_CATALOG_BINDING_INVALID");
  const database = path.join(root, "config/collection-rotation.sqlite"), dbRecord = checked(database, MAX.db), walRecord = checked(database + "-wal", MAX.db), shmRecord = checked(database + "-shm", MAX.shm);
  let db, transaction = false, rotation;
  try {
    const DatabaseSync = fixture ? dependencies.DatabaseSync : require("node:sqlite").DatabaseSync;
    db = new DatabaseSync(database, { readOnly: true }); db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN"); transaction = true;
    need(db.prepare("PRAGMA query_only").get().query_only === 1, "QUERY_ONLY_NOT_CONFIRMED");
    const state = db.prepare("SELECT version,revision,cursor,plan_state,reason,updated_at,CASE WHEN length(CAST(config_json AS BLOB))<=262144 THEN config_json END AS config_json FROM rotation_state WHERE id=1").get();
    need(state && state.version === 1 && count(state.revision) && count(state.cursor), "ROTATION_STATE_INVALID"); const config = configJson(state.config_json); need(state.cursor < config.keywords.length, "CURSOR_INVALID");
    const rows = db.prepare("SELECT id,day,slot_index,worker_key,keyword,scheduled_at,status,started_at,finished_at,error_code,length(CAST(result_json AS BLOB)) AS result_bytes,length(CAST(receipt_json AS BLOB)) AS receipt_bytes FROM rotation_slots ORDER BY day,slot_index LIMIT 2001").all();
    need(rows.length <= 2000, "ROTATION_SLOT_BOUNDS"); const slots = rows.map(row => P.slotSummary(row)); need(new Set(slots.map(row => row.id)).size === slots.length, "SLOT_DUPLICATE");
    const footprint = db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(config_json AS BLOB))),0) AS bytes FROM rotation_days").get(); need(count(footprint.count) && footprint.count <= 400 && count(footprint.bytes) && footprint.bytes <= 2 * 1024 * 1024, "ROTATION_DAY_BOUNDS");
    const dayRows = db.prepare("SELECT day,revision,cursor_start,cursor_next,created_at,CASE WHEN length(CAST(config_json AS BLOB))<=262144 THEN config_json END AS config_json FROM rotation_days ORDER BY day LIMIT 401").all(); need(dayRows.length === footprint.count, "ROTATION_DAY_BOUNDS");
    const days = dayRows.map(row => { need(dayValid(row.day) && count(row.revision) && count(row.cursor_start) && count(row.cursor_next), "DAY_INVALID"); configJson(row.config_json); return { day: row.day, revision: row.revision, cursorStart: row.cursor_start, cursorNext: row.cursor_next, createdAt: time(row.created_at), configSha256: hash(row.config_json) }; });
    const trialFootprint = db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(workers_json AS BLOB))),0) AS bytes FROM rotation_one_day_trials").get(); need(count(trialFootprint.count) && trialFootprint.count <= 100 && count(trialFootprint.bytes) && trialFootprint.bytes <= 2 * 1024 * 1024, "TRIAL_BOUNDS");
    const trialRows = db.prepare("SELECT trial_id,day,base_revision,base_plan_hash,created_at,cancelled_at,allocated_at,CASE WHEN length(CAST(workers_json AS BLOB))<=262144 THEN workers_json END AS workers_json FROM rotation_one_day_trials ORDER BY day,trial_id LIMIT 101").all(); need(trialRows.length === trialFootprint.count, "TRIAL_BOUNDS");
    const trials = trialRows.map(row => { need(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.trial_id || "") && dayValid(row.day) && count(row.base_revision) && SHA.test(row.base_plan_hash || "") && typeof row.workers_json === "string", "TRIAL_INVALID"); return { trialId: row.trial_id, day: row.day, baseRevision: row.base_revision, basePlanHash: row.base_plan_hash, workersSha256: hash(row.workers_json), createdAt: time(row.created_at), cancelledAt: time(row.cancelled_at), allocatedAt: time(row.allocated_at) }; });
    const events = db.prepare("SELECT COUNT(*) AS count,MAX(id) AS lastId,MAX(at) AS lastAt FROM rotation_events").get(); need(count(events.count) && (events.lastId === null || count(events.lastId)), "EVENT_COUNT_INVALID"); events.lastAt = time(events.lastAt);
    db.exec("COMMIT"); transaction = false; db.close(); db = null;
    const allocation = row => ({ id: row.id, day: row.day, index: row.index, workerKey: row.workerKey, keyword: row.keyword, scheduledAt: row.scheduledAt }), historical = slots.filter(row => row.day < day), today = slots.filter(row => row.day === day);
    rotation = { state: { version: state.version, revision: state.revision, cursor: state.cursor, planState: code(state.plan_state), reason: code(state.reason), updatedAt: time(state.updated_at), config, configRawSha256: hash(state.config_json), sixSlotConfigVerified: sixSlot(config, state.revision) }, slotCount: slots.length, dayCount: days.length, allocationSha256: hash(JSON.stringify(slots.map(allocation))), executionMetadataSha256: hash(JSON.stringify(slots)),
      today: { day, slotCount: today.length, allocationSha256: hash(JSON.stringify(today.map(allocation))), items: today }, historical: { beforeDay: day, slotCount: historical.length, allocationSha256: hash(JSON.stringify(historical.map(allocation))), executionMetadataSha256: hash(JSON.stringify(historical)), daySnapshotsSha256: hash(JSON.stringify(days.filter(row => row.day < day))) }, daySnapshotsSha256: hash(JSON.stringify(days)), trials: { count: trials.length, sha256: hash(JSON.stringify(trials)) }, events,
      database: { bytes: dbRecord.stat.size, walBytes: walRecord.stat.size, shmBytes: shmRecord.stat.size, dbAndWalStable: true, existingShmIdentityStable: true, queryOnly: true, nativeReadOnly: true } };
  } finally { if (transaction) { try { db?.exec("ROLLBACK"); } catch {} } try { db?.close(); } catch {} }
  stable(dbRecord); stable(walRecord); stable(shmRecord, true); for (const record of records) stable(record);
  const output = { schemaVersion: 1, purpose: "keyword_monthly_dashboard_ui_only_preservation", status: "read_verified", beganAt, observedAt: new Date().toISOString(), day, fixtureOnly: fixture,
    expectedContext: { name: "glamping-datalab-v2", renderServiceId: "srv-da9q6don74is738t7id0", cwdMatchesCentralSource: fixture ? false : process.cwd() === source, binding: "authenticated central web Render Shell required; no environment read" },
    rotation, individualSchedules: schedule.map(record => fileSummary(record, root)), brokers, webCollector, postprocess,
    monthlyProjection: { generation: pointer.generation, pointerSha256: pointerRead.sha256, catalogSha256: catalogRead.sha256, scopeCount: catalogRead.data.scopes.length, publishedAt: pointer.publishedAt },
    explicitApplicationWrites: 0, explicitSqlMutations: 0, apiCalls: 0, providerCalls: 0, appStarted: false, originalRowsRead: false, sourceFilesRead: false, kosisPathsRead: false, authenticationOrEnvironmentRead: false,
    limitations: ["Saved metadata only. No collector readiness, account quota, original row audit or runtime commit binding.", "Separate saved JSON files are stable during this read but are not one jointly atomic filesystem snapshot.", "SQLite readOnly/query_only may update existing SHM read marks; filesystem/syscall writes zero is not claimed.", "Result/receipt content is not read; only bounded metadata and byte lengths contribute to historical hashes.", "KOSIS is intentionally not read. Continued hold is an instruction and code-scope preservation claim, not a fresh policy-file verification."] };
  need(Buffer.byteLength(JSON.stringify(output)) <= MAX.output, "OUTPUT_BOUNDS"); return output;
}
function compareSnapshots(before, after) {
  need(before?.status === "read_verified" && after?.status === "read_verified" && before.purpose === after.purpose && before.day === after.day, "DASHBOARD_COMPARISON_SAME_DAY_REQUIRED");
  const checks = {}, same = (name, a, b) => { checks[name] = JSON.stringify(a) === JSON.stringify(b); };
  checks.sixSlotConfigVerified = before.rotation.state.sixSlotConfigVerified === true && after.rotation.state.sixSlotConfigVerified === true;
  same("configRawSha256", before.rotation.state.configRawSha256, after.rotation.state.configRawSha256); same("revision", before.rotation.state.revision, after.rotation.state.revision);
  for (const key of ["allocationSha256", "daySnapshotsSha256"]) same(key, before.rotation[key], after.rotation[key]);
  for (const key of ["allocationSha256", "executionMetadataSha256", "daySnapshotsSha256"]) same("historical." + key, before.rotation.historical[key], after.rotation.historical[key]);
  same("trials", before.rotation.trials, after.rotation.trials); same("individualSchedules", before.individualSchedules, after.individualSchedules);
  same("monthlyProjection", before.monthlyProjection, after.monthlyProjection);
  checks.brokerLedgersComparable = before.brokers.length === 2 && after.brokers.length === 2;
  for (let i = 0; i < 2; i++) { const a = before.brokers[i], b = after.brokers[i]; checks[`broker${i}.existingJobsPreserved`] = a?.jobIdsComplete === true && b?.jobIdsComplete === true && a.jobIds.every(id => b.jobIds.includes(id)); same(`broker${i}.guards`, guardFields(a || {}), guardFields(b || {})); }
  same("webGuards", guardFields(before.webCollector), guardFields(after.webCollector));
  const naturallyAdvanced = [];
  for (const [name, a, b] of [["rotation.executionMetadata", before.rotation.executionMetadataSha256, after.rotation.executionMetadataSha256], ["rotation.cursor", before.rotation.state.cursor, after.rotation.state.cursor], ["rotation.events", before.rotation.events, after.rotation.events], ["postprocess", before.postprocess.metadataSha256, after.postprocess.metadataSha256], ["webCollector", before.webCollector.ledger.sha256, after.webCollector.ledger.sha256], ...before.brokers.map((row, i) => [`broker${i}.metadata`, row.jobMetadataSha256, after.brokers[i]?.jobMetadataSha256])]) if (JSON.stringify(a) !== JSON.stringify(b)) naturallyAdvanced.push(name);
  return { schemaVersion: 1, status: Object.values(checks).every(Boolean) ? "preserved" : "needs_verification", day: after.day, checks, naturallyAdvanced, kosisRead: false, originalRowsAudited: false, sourcePreservationBasis: "separate reviewed Git diff, not source-file reads in this verifier", pointerChangeRequiresSeparateRefreshEvidence: checks.monthlyProjection === false };
}
function run() { try { const output = captureSaved(); console.log("MONTHLY_DASHBOARD_PRESERVATION " + JSON.stringify(output)); return output; } catch (error) { const output = { schemaVersion: 1, status: "unknown", code: /^[A-Z0-9_]{1,100}$/.test(error.code || "") ? error.code : "DASHBOARD_PRESERVATION_READ_UNAVAILABLE", explicitApplicationWrites: 0, explicitSqlMutations: 0, apiCalls: 0, providerCalls: 0, appStarted: false, kosisPathsRead: false }; console.log("MONTHLY_DASHBOARD_PRESERVATION " + JSON.stringify(output)); process.exitCode = 1; return output; } }
module.exports = { captureSaved, compareSnapshots, run, configJson, sixSlot, MAX };
if (require.main === module) run();
