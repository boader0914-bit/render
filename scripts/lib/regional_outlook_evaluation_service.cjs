"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRegionalAnalysisStore } = require("./regional_analysis_store.cjs");
const { buildRegionalOutlookEvaluation } = require("./regional_outlook_evaluation.cjs");
const { shiftMonth } = require("./regional_analysis_snapshot.cjs");

const STORAGE_VERSION = "regional-outlook-evaluation-storage-v1";
const FORECAST_STORAGE_VERSION = "regional-outlook-storage-v1";
const kstMonth = value => new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 7);
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value || "");
const month = value => /^20\d{2}-(0[1-9]|1[0-2])$/.test(value || "");
const fault = (code = "REGIONAL_SOURCE_UNAVAILABLE", statusCode = 503) => Object.assign(new Error(code), { code, statusCode });
async function read(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw fault("REGIONAL_STORE_UNAVAILABLE"); }
}

// Only a successful publication callback or a surviving published reference
// can enter this journal. A result file alone is insufficient: a failed or
// month-boundary publication can leave an unreferenced immutable result.
function createForecastPublicationJournal({ dataDir, now = () => new Date() }) {
  const root = path.resolve(dataDir, "regional_outlook_evaluation", "publications");
  const forecastRoot = path.resolve(dataDir, "regional_outlook");
  const keyFor = scope => hash([FORECAST_STORAGE_VERSION, scope.regionKey, scope.months, scope.month]);
  function valid(snapshot) {
    return snapshot?.schemaVersion === 1 && snapshot.calculationVersion === FORECAST_STORAGE_VERSION && uuid(snapshot.resultId)
      && typeof snapshot.scope?.regionKey === "string" && month(snapshot.scope?.month) && [13, 24].includes(snapshot.scope?.months)
      && snapshot.asOfMonth === snapshot.scope.month && Number.isFinite(Date.parse(snapshot.generatedAt)) && Array.isArray(snapshot.metrics);
  }
  async function capture(snapshot, publication = {}) {
    if (!valid(snapshot)) throw fault("REGIONAL_RESULT_INVALID");
    const publishedAt = publication.publishedAt || new Date(now()).toISOString();
    if (!Number.isFinite(Date.parse(publishedAt))) throw fault("REGIONAL_RESULT_INVALID");
    const directory = path.join(root, hash(snapshot.scope.regionKey), snapshot.scope.month);
    const target = path.join(directory, `${snapshot.resultId}.json`);
    const record = { schemaVersion: 1, recordedAt: new Date(now()).toISOString(), publication: { status: "published", publishedAt,
      proof: publication.proof === "saved_reference" ? "saved_reference" : "journal",
      coverage: publication.proof === "saved_reference" ? "legacy_reference" : "recorded" }, snapshot };
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify(record)); await handle.sync(); await handle.close(); handle = null;
      // Linking a fully written file publishes atomically without replacing an
      // existing receipt. Reused forecast results retain their first receipt.
      try { await fs.link(temporary, target); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      const stored = await read(target);
      if (stored?.schemaVersion !== 1 || !valid(stored.snapshot) || stored.snapshot.resultId !== snapshot.resultId
        || hash(stored.snapshot) !== hash(snapshot) || stored.publication?.status !== "published") throw fault("REGIONAL_RESULT_INVALID");
      return { ...stored.snapshot, publication: stored.publication };
    } catch (error) { throw fault(error.code === "REGIONAL_RESULT_INVALID" ? error.code : "REGIONAL_STORE_UNAVAILABLE"); }
    finally { if (handle) await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
  }
  async function load(regionKey, through) {
    const from = shiftMonth(through, -11), state = await read(path.join(forecastRoot, "queue.json"));
    // Bootstrap only surviving successful jobs and saved pointers, never scan
    // the results directory or invent historical forecasts from today's data.
    if (state && (state.schemaVersion !== 1 || !state.results || !state.jobs)) throw fault("REGIONAL_STORE_UNAVAILABLE");
    const refs = new Map();
    const add = (scope, id, publishedAt) => {
      if (!scope || scope.regionKey !== regionKey || !month(scope.month) || scope.month < from || scope.month > through
        || ![13, 24].includes(scope.months) || !uuid(id)) return;
      const key = `${keyFor(scope)}:${id}`, prior = refs.get(key);
      if (!prior || Number.isFinite(Date.parse(publishedAt)) && (!prior.publishedAt || publishedAt < prior.publishedAt)) refs.set(key, { scope, id, publishedAt });
    };
    for (const job of Object.values(state?.jobs || {})) if (job?.status === "completed" && job.scopeKey === keyFor(job.scope || {})) add(job.scope, job.resultId, job.finishedAt);
    for (const [key, result] of Object.entries(state?.results || {})) {
      const scope = result?.scope;
      if (!scope || scope.regionKey !== regionKey || key !== keyFor(scope) || scope.month < from || scope.month > through) continue;
      for (const id of [result.resultId, ...(Array.isArray(result.revisions) ? result.revisions : [])]) add(scope, id);
      const pointer = await read(path.join(forecastRoot, "latest", `${key}.json`));
      if (pointer?.schemaVersion === 1 && pointer.scopeKey === key) for (const id of [pointer.resultId, ...(Array.isArray(pointer.revisions) ? pointer.revisions : [])]) add(scope, id);
    }
    for (const { scope, id, publishedAt } of refs.values()) {
      const snapshot = await read(path.join(forecastRoot, "results", keyFor(scope), `${id}.json`));
      if (!valid(snapshot) || snapshot.resultId !== id || keyFor(snapshot.scope) !== keyFor(scope)) throw fault("REGIONAL_RESULT_INVALID");
      await capture(snapshot, { proof: "saved_reference", publishedAt: publishedAt || snapshot.generatedAt });
    }
    const forecasts = [];
    for (let index = -11; index <= 0; index++) {
      const period = shiftMonth(through, index), directory = path.join(root, hash(regionKey), period);
      const files = await fs.readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw fault("REGIONAL_STORE_UNAVAILABLE"); });
      for (const file of files.filter(file => uuid(file.slice(0, -5)) && file.endsWith(".json")).sort()) {
        const record = await read(path.join(directory, file)), snapshot = record?.snapshot;
        if (record?.schemaVersion !== 1 || !valid(snapshot) || snapshot.scope.regionKey !== regionKey || snapshot.scope.month !== period
          || snapshot.resultId !== file.slice(0, -5) || record.publication?.status !== "published") throw fault("REGIONAL_RESULT_INVALID");
        forecasts.push({ ...snapshot, publication: record.publication });
      }
    }
    return forecasts;
  }
  return { capture, load };
}

function createRegionalOutlookEvaluationService({ dataDir, resolveRegion, readIndicators, now = () => new Date(), autoStart = true }) {
  if (typeof readIndicators !== "function") throw new TypeError("Cache-only indicator reader required");
  const journal = createForecastPublicationJournal({ dataDir, now });
  let publicationError = null;
  const store = createRegionalAnalysisStore({ dataDir, resolveRegion, now, autoStart,
    directoryName: "regional_outlook_evaluation", calculationVersion: STORAGE_VERSION, defaultMonth: kstMonth,
    retainFailedGroups: false, rollForward: true, isMutableScope: scope => scope.month === kstMonth(now()),
    buildSnapshot: async (scope, options) => {
      if (options.collectMissing) throw fault();
      const forecastSnapshots = await journal.load(scope.regionKey, scope.month);
      let observations = null;
      if (forecastSnapshots.length) {
        observations = await readIndicators({ ...scope, month: shiftMonth(scope.month, -1) }, { collectMissing: false });
        if (!observations || observations.scope?.regionKey !== scope.regionKey || observations.networkAttempted === true || observations.refreshRequested === true
          || !Array.isArray(observations.groups) || observations.groups.length && observations.groups.every(group => ["failed", "error", "blocked"].includes(group.status))) throw fault();
      }
      const result = buildRegionalOutlookEvaluation({ forecastSnapshots, observationSnapshots: observations ? [observations] : [], asOfAt: new Date(now()).toISOString() });
      const prior = (await store.get({ regionKey: scope.regionKey, month: scope.month, months: scope.months })).snapshot;
      // A temporary lost/error/partial cache read cannot erase an already
      // compared row. A genuine corrected normal value creates a new result.
      const identity = row => JSON.stringify([row.regionKey, row.issueMonth, row.targetPeriod, row.kind, row.groupKey, row.metricKey, row.predictionRef?.resultId]);
      const current = new Map((result.rows || []).map(row => [identity(row), row]));
      const invalidActual = new Set(["DUPLICATE_ACTUAL_OBSERVATION", "INVALID_ACTUAL_VALUE", "CONFLICTING_ACTUAL_OBSERVATIONS", "UNSUPPORTED_ACTUAL_TIMESTAMP",
        "UNIT_MISMATCH", "PROVIDER_MISMATCH", "ACTUAL_SCOPE_PERIOD_MISMATCH", "UNSUPPORTED_ACTUAL_METADATA", "UNSUPPORTED_ACTUAL_PERIOD_TYPE", "ACTUAL_RECEIVED_BEFORE_MONTH_CLOSED"]);
      if ((prior?.rows || []).some(row => row.status === "compared" && row.issueMonth >= shiftMonth(scope.month, -11)
        && (current.get(identity(row))?.status === "pending" || invalidActual.has(current.get(identity(row))?.reasonCode)))) throw fault();
      publicationError = null;
      return { ...result, scope, groups: [], cacheOnly: true, networkAttempted: false,
        availableIssueMonths: [...new Set((result.rows || []).map(row => row.issueMonth))].sort().reverse() };
    }
  });
  async function get(input) {
    const response = await store.get(input);
    return publicationError ? { ...response, storage: { ...response.storage, errorCode: response.storage.errorCode || publicationError } } : response;
  }
  async function request(input, options = {}) {
    if (options.collectMissing === true) throw fault("REGIONAL_INVALID_REQUEST", 400);
    if (input?.month && input.month !== kstMonth(now())) throw fault("REGIONAL_PAST_OUTLOOK_READ_ONLY", 400);
    const started = await store.request(input, { ...options, collectMissing: false });
    return { ...await get(input), ...started };
  }
  async function recordPublication(snapshot) {
    try {
      await journal.capture(snapshot);
      publicationError = null;
      const changed = await store.sourceChanged({ regionKey: snapshot.scope.regionKey, sourceKey: "forecast_publication", sourceVersion: snapshot.resultId });
      return changed.ignored ? await request({ regionKey: snapshot.scope.regionKey, months: 13 }, { reason: "source_changed" }) : changed;
    } catch (error) { publicationError = "REGIONAL_STORE_UNAVAILABLE"; throw error; }
  }
  return { ...store, get, request, recordPublication };
}

module.exports = { createRegionalOutlookEvaluationService, createForecastPublicationJournal, STORAGE_VERSION };
