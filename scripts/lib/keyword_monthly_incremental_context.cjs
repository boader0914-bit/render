"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const H = require("./keyword_monthly_refresh_preparation.cjs");
const { createStore } = require("./keyword_monthly_incremental_state.cjs");
const { createKeywordMonthlySourceDelta } = require("./keyword_monthly_source_delta.cjs");
const { createIncrementalCatalog } = require("./keyword_monthly_incremental_catalog.cjs");
const { compactMonthlyCapacityCompany } = require("./monthly_company_source_catalog.cjs");
const { buildSourceWiring } = require("./keyword_monthly_source_wiring.cjs");
const { productCapacityBaselineAt } = require("./product_capacity_baseline.cjs");
const { productCapacityCorrectionSignature } = require("./product_capacity_store.cjs");
const { capacityIdentityOwnership } = require("./company_capacity_registry.cjs");
const sha = v => crypto.createHash("sha256").update(v).digest("hex");
const compact = raw => ({ ...compactMonthlyCapacityCompany(raw), ...(Object.hasOwn(raw, "name") ? { name: raw.name } : {}) });
const identityToken = value => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
function companyDependencyKeywords({ companies, companyIds, partitions, runs }) {
  const owners = new Map(), references = new Map(), touched = new Set(companyIds.map(identityToken).filter(Boolean)), pending = [...touched], affected = new Set();
  for (const entry of companies) {
    const company = entry.compact, refs = new Set([entry.companyId,
      ...(company.duplicateNotes || []).map(note => note.mergedCompanyId),
      ...(company.placeIds || []).flatMap(id => [id, `cmp_place_${id}`])].map(identityToken).filter(Boolean));
    references.set(entry.companyId, refs);
    for (const ref of refs) { const matches = owners.get(ref) || new Set(); matches.add(entry.companyId); owners.set(ref, matches); }
  }
  // Alias/place collisions may involve several companies. Invalidating their
  // complete connected component is conservative and never changes ownership.
  for (let index = 0; index < pending.length; index++) for (const id of owners.get(pending[index]) || []) {
    if (affected.has(id)) continue; affected.add(id);
    for (const ref of references.get(id)) if (!touched.has(ref)) { touched.add(ref); pending.push(ref); }
  }
  const keywords = new Set(), runMap = new Map(runs.map(run => [String(run.id || run.runId), run]));
  for (const entry of companies) if (affected.has(entry.companyId)) for (const exposure of Object.values(entry.compact.keywords || {})) if (exposure.keyword) keywords.add(exposure.keyword);
  for (const part of partitions) {
    const key = identityToken(part.companyKey || part.companyId), inferred = key.match(/^cmp_place_(.+)$/)?.[1] || (/^\d+$/.test(key) ? key : "");
    if (![part.companyKey, part.companyId, part.placeId, part.place_id, inferred].map(identityToken).some(ref => ref && touched.has(ref))) continue;
    for (const keyword of part.keywords || []) if (keyword) keywords.add(keyword);
    for (const runId of part.runIds || []) { const keyword = runMap.get(String(runId))?.keyword; if (keyword) keywords.add(keyword); }
  }
  return [...keywords];
}
async function events(outbox) {
  const descriptors = []; let offset = 0, inventory;
  do {
    const r = await outbox.listEvents({ limit: 128, offset, ...(inventory ? { expectedInventorySha256: inventory } : {}) });
    H.need(r.status === "available" && Array.isArray(r.events) && Array.isArray(r.incompleteEventIds) && r.incompleteEventIds.length === 0, "KEYWORD_INCREMENTAL_OUTBOX_INCOMPLETE");
    inventory ||= r.inventorySha256; descriptors.push(...r.events); H.need(descriptors.length <= 50000, "KEYWORD_INCREMENTAL_OUTBOX_BOUND"); offset = r.nextOffset;
  } while (offset !== null);
  return { descriptors, inventory };
}
function runDependency({ details, maximumRoomCapacity, outputs, codeFingerprint, onDependency = null }) {
  const { run, capacityCompanies, targetCompanyIds, productCapacityEvidenceRevision } = details;
  H.need(run && typeof run.id === "string" && Array.isArray(capacityCompanies) && Array.isArray(targetCompanyIds), "KEYWORD_INCREMENTAL_RUN_DEPENDENCY_UNKNOWN");
  const files = outputs.files.filter(f => f.relative.startsWith(run.id + "/"));
  H.need(files.some(f => f.relative === run.id + "/manifest.json"), "KEYWORD_INCREMENTAL_RUN_DEPENDENCY_UNKNOWN");
  const companies = capacityCompanies.map(company => {
    const value = Object.fromEntries(Object.entries(company).filter(([key]) => !["keywords", "runIds", "firstRunId", "lastRunId", "inventory", "_monthlySourceFallbackMonths", "_monthlySourceCompact"].includes(key)));
    const signature = productCapacityCorrectionSignature(company);
    const evidence = [...(company._productCapacityEvidence || []), ...[company.inventory?.latest, company.inventory?.previousLatest, ...(company.inventory?.snapshots || [])]
      .filter(s => s?.productSnapshot?.productCapacityCorrectionSignature === signature).flatMap(s => s.productSnapshot?.productCapacityEvidence || [])];
    value.inventoryDependency = { maximumRoomCapacity: maximumRoomCapacity(company), productCapacityAtRun: productCapacityBaselineAt(evidence, company.companyId, run.collectedAt) };
    return value;
  });
  // Full current provider identity population binds ambiguous matches. Changes
  // to capacity, identity or reviewed inputs deliberately invalidate old units.
  const revision = sha(JSON.stringify(["keyword-run-correction-dependency-v1", codeFingerprint, run, files, companies, targetCompanyIds, productCapacityEvidenceRevision]));
  if (onDependency) onDependency({ runId: run.id, targetCompanyIdsSha256: sha(JSON.stringify(targetCompanyIds)), runSha256: sha(JSON.stringify(run)), filesSha256: sha(JSON.stringify(files)),
    companyInputsSha256: sha(JSON.stringify(companies)), productCapacityEvidenceRevision, codeFingerprint, revision });
  return revision;
}
async function createContext({ dataDir, codeRoot, workDataDir, capturedAt, outputs, runs, regions, admission = async () => {}, outbox = createKeywordMonthlySourceDelta({ dataDir }), bootstrapAllowed = true, expectedOutboxInventorySha256 = null, admittedRunIds = null, onRunDependency = null }) {
  const store = createStore({ dataDir, now: () => new Date(capturedAt), admission }); await store.initialize();
  const inventory = await events(outbox); H.need(expectedOutboxInventorySha256 === null || expectedOutboxInventorySha256 === inventory.inventory, "KEYWORD_INCREMENTAL_OUTBOX_CHANGED");
  let current = await store.load(), bootstrap = false;
  if (!current) {
    H.need(bootstrapAllowed, "KEYWORD_INCREMENTAL_BOOTSTRAP_REQUIRED");
    current = await store.bootstrap({ eventIds: inventory.descriptors.map(d => d.eventId), projectCompany: compact, checkpoint: admission }); bootstrap = true;
  } else {
    const applied = new Set(current.state.appliedEvents), fresh = [];
    for (const descriptor of inventory.descriptors) if (!applied.has(descriptor.eventId)) {
      const r = await outbox.readEvent(descriptor.eventId); H.need(r.status === "complete" && r.eventSha256 === descriptor.eventSha256, "KEYWORD_INCREMENTAL_OUTBOX_CHANGED");
      if (r.event.kind === "history" && admittedRunIds !== null) H.need(Array.isArray(admittedRunIds) && admittedRunIds.includes(r.event.payload.runId), "KEYWORD_INCREMENTAL_DELTA_DB_NOT_VERIFIED");
      fresh.push(r.event);
    }
    if (fresh.length) current = await store.apply({ current, events: fresh, projectCompany: compact });
    else await store.assertSources(current.state);
  }
  const state = current.state, originalStateSha256 = current.stateSha256, index = store.createHistoryReader(state);
  const adapter = { revision: current.stateSha256, observationIndex: index, catalog: null, runs, cacheDirectory: path.join(store.directory, "recalculated_run_rows") };
  let wiring;
  adapter.runRevision = details => runDependency({ details, maximumRoomCapacity: wiring.bridge.maximumRoomCapacity, outputs, codeFingerprint: wiring.bindings.codeFingerprint, onDependency: onRunDependency });
  wiring = buildSourceWiring({ codeRoot, copyDataDir: workDataDir, now: capturedAt, readOnlyOriginalOutputs: outputs.root, incremental: adapter });
  // A checkpoint retains prepared references. Only changed/raw-history-touched
  // canonical owners are re-prepared with the existing raw trust algorithm.
  const runMap = new Map(runs.map(r => [String(r.id || r.runId), r]));
  const identityCompanies = Object.fromEntries(state.companies.map(entry => [entry.companyId, entry.compact]));
  const historicalOwnership = await capacityIdentityOwnership(identityCompanies, admission);
  const historicalOwnershipFingerprint = sha(JSON.stringify([...historicalOwnership]));
  let basis; try { basis = (await H.read(path.join(workDataDir, "company_integrated/capacity-bases.json"), 8 * 1024 * 1024)).value; } catch (e) { if (e.code !== "ENOENT") throw e; basis = { companies: {} }; }
  const preparationKeys = new Map(state.companies.map(e => {
    const aliases = new Set([e.companyId, ...(e.compact.duplicateNotes || []).map(n => n.mergedCompanyId).filter(Boolean)]);
    const parts = state.history.partitions.filter(p => aliases.has(String(p.companyId || p.companyKey || "")));
    const runIds = new Set([...parts.flatMap(p => p.runIds), ...Object.values(e.compact.keywords || {}).flatMap(k => (k.runs || []).map(r => r.runId))]);
    for (const s of [e.compact.inventory?.latest, e.compact.inventory?.previousLatest, ...(e.compact.inventory?.snapshots || [])].filter(Boolean)) for (const id of [s.runId, s.productSnapshot?.runId, s.productSnapshot?.dailyRunId]) if (id) runIds.add(id);
    return [e.companyId, sha(JSON.stringify([wiring.bindings.codeFingerprint, historicalOwnershipFingerprint, e.sha256, basis.companies?.[e.companyId] || null, parts.map(p => [p.key, p.digest]), [...runIds].sort().map(id => [id, runMap.get(id)?.collectionQuality || null])]))];
  }));
  const needed = state.companies.filter(e => e.preparationKey !== preparationKeys.get(e.companyId));
  if (needed.length) {
    const raw = Object.create(null); for (const e of needed) { await admission(); raw[e.companyId] = await store.readCompany(e.companyId, e); }
    const prepared = await wiring.bridge.prepareCompanies(raw, { runs, identityCompanies, shareReadOnlyInventory: true, checkpoint: admission });
    for (const e of needed) { H.need(prepared[e.companyId], "KEYWORD_INCREMENTAL_PREPARATION_INCOMPLETE"); e.compact = compact(prepared[e.companyId]); e.preparationKey = preparationKeys.get(e.companyId); }
    state.dirtyCompanyIds = [...new Set([...state.dirtyCompanyIds, ...needed.map(e => e.companyId)])];
    state.dirtyKeywords = [...new Set([...(state.dirtyKeywords || []), ...needed.flatMap(e => Object.values(e.compact.keywords || {}).map(k => k.keyword).filter(Boolean))])];
  }
  state.dirtyKeywords = [...new Set([...(state.dirtyKeywords || []), ...companyDependencyKeywords({ companies: state.companies,
    companyIds: [...new Set([...(state.dirtyCompanyIds || []), ...needed.map(entry => entry.companyId)])], partitions: state.history.partitions, runs })])];
  state.prepared = true;
  // Run metadata and calendar changes are explicit dependencies. Their update
  // may require broader dirty scopes even when no new raw history was appended.
  const runFingerprint = sha(JSON.stringify(runs)), regionFingerprint = sha(JSON.stringify(regions));
  const outputByRun = Object.create(null);
  for (const f of outputs.files) { const id = f.relative.split("/")[0]; (outputByRun[id] ||= []).push(f); }
  const outputRunFingerprints = Object.fromEntries(Object.entries(outputByRun).map(([id, files]) => [id, sha(JSON.stringify(files))]));
  const priorRuns = new Map((state.runs || []).map(r => [String(r.id || r.runId), sha(JSON.stringify(r))]));
  const updatedOldRun = [...priorRuns].some(([id, fingerprint]) => !runMap.has(id) || sha(JSON.stringify(runMap.get(id))) !== fingerprint
    || state.outputRunFingerprints?.[id] !== outputRunFingerprints[id]);
  if (updatedOldRun || state.regionFingerprint && state.regionFingerprint !== regionFingerprint) state.globalDiagnosticsDirty = true;
  const dependencyChanged = state.runFingerprint !== runFingerprint || state.regionFingerprint !== regionFingerprint;
  state.runFingerprint = runFingerprint; state.regionFingerprint = regionFingerprint;
  state.runs = runs; state.outputRunFingerprints = outputRunFingerprints;
  state.lastPreparedAt = capturedAt; current = await store.save(state, current.pointerSha256); adapter.revision = current.stateSha256;
  const byId = new Map(state.companies.map(e => [e.companyId, e]));
  adapter.catalog = await createIncrementalCatalog({ entries: state.companies, runs, regions, revision: adapter.revision,
    readRawCompany: id => store.readCompany(id, byId.get(id)), capacityForCompany: wiring.bridge.capacityForCompany,
    assertCurrent: async () => { await admission(); await store.assertPointer(current.stateSha256); } });
  await store.assertSources(state);
  return { store, current, state, wiring, index, bootstrap, dependencyChanged, originalStateSha256, outboxInventorySha256: inventory.inventory,
    async assertCurrent() { await admission(); await store.assertSources(state); H.need((await store.load()).stateSha256 === current.stateSha256, "KEYWORD_INCREMENTAL_STATE_CHANGED"); const after = await events(outbox); H.need(after.inventory === inventory.inventory, "KEYWORD_INCREMENTAL_OUTBOX_CHANGED"); },
    metrics: () => ({ ...store.counters, history: index.stats(), source: wiring.metrics, sourceRead: wiring.sources.sourceReadMetrics() }) };
}
module.exports = { createContext, events, compact, runDependency, companyDependencyKeywords };
