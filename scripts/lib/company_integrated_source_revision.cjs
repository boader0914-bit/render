"use strict";
// Saved-input change index only. No provider readers, network, raw writes or
// company/month calculations are invoked here. Corrupt/uncertain indexes fail
// closed so they cannot certify reuse of an old company aggregate.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), readline = require("node:readline");
const { industryCompanyReference } = require("./industry_analysis.cjs");
const { readCompanyMasterProjection } = require("./company_master_stream.cjs");
const VERSION = "company-integrated-source-revision-v2";
const LEGACY_VERSION = "company-integrated-source-revision-v1";
const monthValid = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value || "");
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const token = value => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const text = value => typeof value === "string" ? value : "";
const monthOf = value => /^\d{4}-(0[1-9]|1[0-2])-\d{2}/.test(text(value)) ? value.slice(0, 7) : "";
const collectedMonth = value => Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value) + 32400000).toISOString().slice(0, 7) : "";
const previousMonth = month => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 2, 1)).toISOString().slice(0, 7);
const fault = code => Object.assign(new Error(code), { code, statusCode: 503 });
const requireValid = value => { if (!value) throw fault("COMPANY_SOURCE_REVISION_UNAVAILABLE"); };
function createCompanyIntegratedSourceRevision({ dataDir, outputsDir, regionMasterFile, tourismRegionMapFile, includeContext = true,
  calculationFiles = [], calculationFingerprint = "", fileSystem = fs, historyStream = filename => native.createReadStream(filename, { encoding: "utf8" }), observationIndex = null } = {}) {
  if (!dataDir || !regionMasterFile) throw new TypeError("Company source directory and region reference are required");
  if (observationIndex !== null && (typeof observationIndex.ensure !== "function" || typeof observationIndex.readLines !== "function")) throw new TypeError("A verified observation index is required");
  if (calculationFingerprint !== "" && !/^[a-f0-9]{64}$/.test(calculationFingerprint)) throw new TypeError("Invalid calculation fingerprint");
  const root = path.resolve(dataDir), output = path.resolve(outputsDir || path.join(root, "outputs")), indexFile = path.join(root, "company_integrated", "revision-index.json");
  const codeFiles = [...new Set([__filename, ...calculationFiles.map(file => path.resolve(file))])];
  const configuration = hash([includeContext, codeFiles, calculationFingerprint, observationIndex
    ? typeof observationIndex.revisionPartitions === "function" ? "observation-partitions" : "observation-lines" : "legacy-history"]);
  let cached = null, cachedIndexStat = null, initialized = false, chain = Promise.resolve();
  const signature = stat => `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}:${stat.dev}`;
  async function stat(file) { try { const result = await fileSystem.lstat(file, { bigint: true }); requireValid(!result.isSymbolicLink()); return result; } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
  async function loadIndex() {
    const current = await stat(indexFile), sig = current && signature(current);
    if (initialized && sig === cachedIndexStat) return cached;
    if (!current) { requireValid(!initialized || !cachedIndexStat); initialized = true; cached = null; cachedIndexStat = null; return null; }
    requireValid(current.isFile() && current.size < 32n * 1024n * 1024n);
    let value; try { value = JSON.parse(await fileSystem.readFile(indexFile, "utf8")); } catch { throw fault("COMPANY_SOURCE_REVISION_INDEX_INVALID"); }
    const { checksum, ...body } = value;
    if (![VERSION, LEGACY_VERSION].includes(value.version) || !value.metadata || !value.parts || !value.prepared || checksum !== hash(body)) throw fault("COMPANY_SOURCE_REVISION_INDEX_INVALID");
    if (value.version === VERSION && (!value.contentDigests || value.prepared.version !== VERSION
      || Object.keys(value.contentDigests).length !== Object.keys(value.metadata).length
      || Object.entries(value.metadata).some(([label, metadata]) => metadata === null
        ? value.contentDigests[label] !== null : !/^[a-f0-9]{64}$/.test(value.contentDigests[label] || "")))) throw fault("COMPANY_SOURCE_REVISION_INDEX_INVALID");
    cached = value; initialized = true; cachedIndexStat = sig; return cached;
  }
  async function inventory() {
    const metadata = {}, paths = {};
    async function file(label, filename) { const value = await stat(filename); paths[label] = filename;
      if (!value) { metadata[label] = null; return; } requireValid(value.isFile()); metadata[label] = signature(value); }
    async function tree(prefix, directory, filter = () => true, depth = 0) {
      const before = await stat(directory); if (!before) return;
      requireValid(before.isDirectory() && depth <= 16); const entries = await fileSystem.readdir(directory, { withFileTypes: true });
      for (const entry of entries) { requireValid(!entry.isSymbolicLink()); if (entry.name.endsWith(".tmp")) continue;
        const filename = path.join(directory, entry.name), label = prefix + "/" + entry.name;
        if (entry.isDirectory()) await tree(label, filename, filter, depth + 1);
        else if (entry.isFile() && filter(label)) await file(label, filename);
      }
      const after = await stat(directory); requireValid(after && signature(before) === signature(after));
    }
    await file("master", path.join(root, "company_master", "companies.json"));
    await file("history", path.join(root, "history", "observations.jsonl"));
    await file("capacity", path.join(root, "company_integrated", "capacity-bases.json"));
    await file("regions", path.resolve(regionMasterFile));
    if (tourismRegionMapFile) await file("tourism-map", path.resolve(tourismRegionMapFile));
    for (let index = 0; index < codeFiles.length; index++) await file("engine/" + index, codeFiles[index]);
    await tree("runs", output, label => /\.(?:json|jsonl|csv|xlsx|md|html|png)$/i.test(label));
    await tree("calendar", path.join(root, "history", "special_days"), label => label.endsWith(".json"));
    if (includeContext) {
      await tree("tourism", path.join(root, "tourism_data", "cache"), label => label.endsWith(".json"));
      await tree("kosis", path.join(root, "history", "kosis"), label => /^kosis\/[a-f0-9]{24}(?:-attempt)?[.]json$/.test(label));
      await tree("search", path.join(root, "regional_search_trends", "cache"), label => label.endsWith(".json"));
    }
    return { metadata, paths };
  }
  async function json(label, current, fallback) {
    if (!current.metadata[label]) return fallback;
    const value = await stat(current.paths[label]); requireValid(value && value.size <= 256n * 1024n * 1024n);
    let result; try { result = JSON.parse((await fileSystem.readFile(current.paths[label], "utf8")).replace(/^\uFEFF/, "")); } catch { throw fault("COMPANY_SOURCE_REVISION_UNAVAILABLE"); }
    requireValid(signature(await stat(current.paths[label])) === current.metadata[label]); return result;
  }
  async function contentDigest(label, current) {
    if (current.metadata[label] === null) return null;
    // Stat identity only decides when to reread. Durable dependency tokens use
    // file bytes, so a remount/atomic replacement cannot invalidate every month.
    // Stream even large history/results; never retain whole files for hashing.
    const handle = await fileSystem.open(current.paths[label], "r");
    try {
      const before = await handle.stat({ bigint: true }); requireValid(before.isFile() && signature(before) === current.metadata[label]);
      const digest = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024); let size = 0n;
      while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; digest.update(buffer.subarray(0, bytesRead)); size += BigInt(bytesRead); }
      requireValid(size === before.size && signature(await handle.stat({ bigint: true })) === current.metadata[label]
        && signature(await stat(current.paths[label])) === current.metadata[label]);
      return digest.digest("hex");
    } finally { await handle.close(); }
  }
  async function atomic(value) {
    await fileSystem.mkdir(path.dirname(indexFile), { recursive: true }); const temporary = indexFile + "." + crypto.randomUUID() + ".tmp";
    const encoded = JSON.stringify(value); requireValid(Buffer.byteLength(encoded) < 32 * 1024 * 1024); let handle;
    try { handle = await fileSystem.open(temporary, "wx", 0o600); await handle.writeFile(encoded); await handle.sync(); await handle.close(); handle = null; await fileSystem.rename(temporary, indexFile); }
    finally { if (handle) await handle.close().catch(() => {}); await fileSystem.unlink(temporary).catch(() => {}); }
    cached = value; cachedIndexStat = signature(await stat(indexFile)); initialized = true;
  }
  function resolveRegion(company, units) {
    const exact = (input, address = false) => {
      const normalized = token(input); if (!normalized) return null;
      const direct = units.find(unit => [unit.regionKey, unit.regionId].includes(input)); if (direct) return direct;
      let candidates = units.flatMap(unit => [...new Set([unit.fullName, unit.name, ...(unit.aliases || [])].map(token).filter(Boolean))]
        .filter(alias => address ? normalized.startsWith(alias) : normalized === alias).map(alias => ({ unit, length: alias.length })));
      if (address && candidates.length) candidates = candidates.filter(row => row.length === Math.max(...candidates.map(candidate => candidate.length)));
      const unique = [...new Map(candidates.map(row => [row.unit.regionKey, row.unit])).values()]; return unique.length === 1 ? unique[0] : null;
    };
    const override = company.manualCorrection?.active === false ? null : company.manualCorrection?.regionOverride;
    if (override) return exact(override);
    for (const address of company.addresses || []) { const region = exact(typeof address === "string" ? address : address.address, true); if (region) return region; }
    const matches = [...new Map((company.regions || []).map(value => exact(value)).filter(Boolean).map(region => [region.regionKey, region])).values()];
    if (matches.length === 1) return matches[0]; const locals = matches.filter(region => region.level === "local");
    return locals.length === 1 && matches.every(region => region.regionKey === locals[0].regionKey || region.regionKey === locals[0].provinceRegionKey) ? locals[0] : null;
  }
  async function scan() {
    const old = await loadIndex(), current = await inventory();
    const compatible = old?.version === VERSION;
    if (compatible && old.configuration === configuration && hash(current.metadata) === hash(old.metadata)) return structuredClone(old.prepared);
    const contentDigests = {};
    let indexedHistory = null;
    async function historyDescriptor() {
      if (!indexedHistory) {
        indexedHistory = await observationIndex.ensure();
        requireValid(/^[a-f0-9]{64}$/.test(indexedHistory?.contentDigest || "")
          && (indexedHistory.source?.signature || null) === current.metadata.history
          && Number.isSafeInteger(indexedHistory.malformedLines) && indexedHistory.malformedLines >= 0);
      }
      return indexedHistory;
    }
    for (const label of Object.keys(current.metadata).sort()) contentDigests[label] = current.metadata[label] === null ? null : compatible && old.metadata[label] === current.metadata[label]
      ? old.contentDigests[label] : label === "history" && observationIndex
        // The index's ordered line token is a source-change detector, not an
        // independent SHA of the original file. Scoped row digests below keep
        // their original line bytes and order, including excluded evidence.
        ? (await historyDescriptor()).contentDigest : await contentDigest(label, current);
    // v1 stored stat-only dependencies. They cannot prove byte equality, so
    // migrate once by rebuilding the derived index; old monthly snapshots stay
    // visible until the existing queue verifies their replacement normally.
    const parts = structuredClone(compatible ? old.parts : {}), changed = label => !compatible || old.contentDigests[label] !== contentDigests[label];
    for (const label of Object.keys(parts)) if (label.startsWith("engine/") && !(label in current.metadata)) delete parts[label];
    for (const label of ["regions", "tourism-map", ...Object.keys(current.metadata).filter(key => key.startsWith("engine/"))]) {
      if (changed(label)) { const bytes = current.metadata[label] ? await fileSystem.readFile(current.paths[label]) : null; parts[label] = { digest: hash(bytes?.toString("base64") || null),
        ...(label === "regions" ? { value: await json(label, current, { units: [] }) } : {}) }; }
    }
    const units = (parts.regions?.value?.units || []).filter(unit => unit.active && unit.selectable && ["local", "broad"].includes(unit.level));
    if (changed("master") || changed("regions") || parts.master?.projectionVersion !== 2) {
      const companies = {};
      const consumeCompany = company => {
        if (!company?.companyId || company.deletedAt || company.mergedIntoCompanyId) return;
        const id = String(company.companyId), region = resolveRegion(company, units), months = {}, runs = {}, fallbackCounts = {};
        const add = (month, value, runId) => { if (!monthValid(month)) return; (months[month] ||= []).push(value); if (runId) (runs[month] ||= []).push(String(runId)); };
        for (const snapshot of [company.inventory?.latest, company.inventory?.previousLatest, ...(company.inventory?.snapshots || [])].filter(Boolean)) {
          const product = snapshot.productSnapshot || {};
          for (const row of product.daily || []) { const month = monthOf(row.stayDate || row.date); if (month) fallbackCounts[month] = (fallbackCounts[month] || 0) + 1; add(month, { row, snapshot: { runId: snapshot.runId, collectedAt: snapshot.collectedAt,
            inventoryEvidenceVersion: snapshot.inventoryEvidenceVersion, productRunId: product.runId, productCollectedAt: product.collectedAt, productInventoryEvidenceVersion: product.inventoryEvidenceVersion } }, row.runId || snapshot.runId || product.runId);
          }
        }
        for (const exposure of Object.values(company.keywords || {})) for (const run of exposure.runs || []) add(collectedMonth(run.collectedAt), { rank: run, keyword: exposure.keyword }, run.runId || run.id);
        const regionKeys = [...new Set([region?.regionKey, region?.provinceRegionKey].filter(Boolean))];
        const meta = { companyId: id, primaryName: company.primaryName || id, ...industryCompanyReference(company, units.map(unit => ({ id: unit.regionKey, label: unit.fullName || unit.name, level: unit.level, aliases: unit.aliases }))),
          // Keyword rank series already belong to their observed month. A new
          // keyword label alone is not a dependency of every historical month.
          regionKey: region?.regionKey || "", regionKeys, regionLabel: region?.fullName || "지역 확인 전",
          placeIds: [...new Set((company.placeIds || []).map(value => String(value).trim()).filter(Boolean))], manualCorrection: company.manualCorrection || null };
        const aliases = (company.duplicateNotes || []).map(item => item.mergedCompanyId).filter(Boolean).map(String);
        const inventory = company.inventory || {}, knownRuns = [...new Set([...(company.runIds || []), ...(inventory.runIds || []), company.firstRunId, company.lastRunId,
          inventory.latest?.runId, inventory.previousLatest?.runId, ...(inventory.snapshots || []).map(row => row?.runId),
          ...Object.values(company.keywords || {}).flatMap(exposure => (exposure.runs || []).map(row => row?.runId || row?.id))].filter(Boolean).map(String))].sort();
        companies[id] = { meta: hash(meta), regionKey: region?.regionKey || "", regionId: region?.regionId || region?.regionKey || "", aliases, places: meta.placeIds,
          months: Object.fromEntries(Object.entries(months).map(([month, values]) => [month, hash(values)])), fallbackCounts, knownRuns,
          runs: Object.fromEntries(Object.entries(runs).map(([month, values]) => [month, [...new Set(values)].sort()])) };
      };
      if (current.metadata.master) {
        if (fileSystem === fs) {
          const before = await stat(current.paths.master);
          requireValid(before && before.size <= 256n * 1024n * 1024n && signature(before) === current.metadata.master);
          await readCompanyMasterProjection(current.paths.master, { projectCompany: null, onCompany: consumeCompany,
            checkpoint: () => new Promise(resolve => setImmediate(resolve)) });
          requireValid(signature(await stat(current.paths.master)) === current.metadata.master);
        } else {
          // Preserve custom filesystem adapters; do not bypass their I/O policy.
          const master = await json("master", current, { companies: {} }); requireValid(master.companies && !Array.isArray(master.companies));
          for (const company of Object.values(master.companies)) consumeCompany(company);
        }
      }
      const placeOwners = new Map(), conflictIds = new Set(), fallbackUnknown = {};
      for (const [id, company] of Object.entries(companies)) for (const place of company.places) {
        if (placeOwners.has(place) && placeOwners.get(place) !== id) { if (placeOwners.get(place)) conflictIds.add(placeOwners.get(place)); conflictIds.add(id); placeOwners.set(place, null); } else placeOwners.set(place, id);
      }
      for (const id of conflictIds) for (const [month, count] of Object.entries(companies[id].fallbackCounts)) fallbackUnknown[month] = (fallbackUnknown[month] || 0) + count;
      const canonicalIds = new Map(Object.keys(companies).map(id => [token(id), id]));
      for (const [id, company] of Object.entries(companies)) for (const alias of company.aliases) canonicalIds.set(token(alias), id);
      parts.master = { projectionVersion: 2, companies, identity: hash({ ids: [...canonicalIds].sort(), places: [...placeOwners].sort(), conflicts: [...conflictIds].sort() }), fallbackUnknown };
    }
    const ids = new Map(Object.keys(parts.master.companies).map(id => [token(id), id])), places = new Map(), conflicts = new Set();
    for (const [id, company] of Object.entries(parts.master.companies)) {
      for (const alias of company.aliases) ids.set(token(alias), id);
      for (const place of company.places) {
        if (places.has(place) && places.get(place) !== id) { if (places.get(place)) conflicts.add(places.get(place)); conflicts.add(id); places.set(place, null); }
        else places.set(place, id);
      }
    }
    for (const [id, company] of Object.entries(parts.master.companies)) {
      // Include effective ownership, not merely this company's own list: a
      // newly added company can make an existing place or alias ambiguous.
      company.identity = hash({ keys: [...new Set([id, ...company.aliases].map(token))].sort().map(key => [key, ids.get(key) || null]),
        places: [...new Set(company.places)].sort().map(place => [place, places.get(place) || null]), conflicted: conflicts.has(id) });
    }
    if (changed("capacity")) { const value = await json("capacity", current, { companies: {} }); requireValid(value.companies && !Array.isArray(value.companies)); parts.capacity = Object.fromEntries(Object.entries(value.companies).map(([id, entry]) => [id, hash(entry)])); }
    const historyKind = typeof observationIndex?.revisionPartitions === "function" ? "canonical-raw-partitions-v1" : "ordered-canonical-lines-v1";
    if (changed("history") || parts.master.identity !== old?.parts?.master?.identity || parts.history?.kind !== historyKind) {
      const rows = {}, runRefs = {}, unknown = {}, digests = new Map(); let malformed = 0;
      function consume(line, row) {
        const month = monthOf(row.stayDate || row.date); if (!month) return;
        const key = token(row.companyKey || row.companyId), place = String(row.placeId || row.place_id || key.match(/^cmp_place_(.+)$/)?.[1] || (/^\d+$/.test(key) ? key : ""));
        const candidate = ids.get(key) || places.get(place), id = candidate && !conflicts.has(candidate) ? candidate : null; if (!id) { unknown[month] = (unknown[month] || 0) + 1; if (!candidate) return; }
        const sourceId = id || candidate, identity = JSON.stringify([sourceId, month]); if (!digests.has(identity)) digests.set(identity, crypto.createHash("sha256")); digests.get(identity).update(line + "\n");
        if (row.runId) { ((runRefs[sourceId] ||= {})[month] ||= new Set()).add(String(row.runId)); }
      }
      if (current.metadata.history) {
        if (historyKind === "canonical-raw-partitions-v1") {
          const indexed = await observationIndex.revisionPartitions();
          requireValid((indexed?.source?.signature || null) === current.metadata.history && Array.isArray(indexed.partitions)
            && Number.isSafeInteger(indexed.malformedLines) && indexed.malformedLines >= 0);
          malformed = indexed.malformedLines;
          const keys = new Set();
          for (const partition of indexed.partitions) {
            requireValid(partition && typeof partition.key === "string" && !keys.has(partition.key)
              && /^[a-f0-9]{64}$/.test(partition.digest || "") && Number.isSafeInteger(partition.count) && partition.count > 0
              && Array.isArray(partition.runIds) && partition.runIds.every(runId => typeof runId === "string"));
            keys.add(partition.key);
            const month = partition.month; if (!monthValid(month)) continue;
            const key = token(partition.companyKey || partition.companyId), place = String(partition.placeId || partition.place_id || key.match(/^cmp_place_(.+)$/)?.[1] || (/^\d+$/.test(key) ? key : ""));
            const candidate = ids.get(key) || places.get(place), id = candidate && !conflicts.has(candidate) ? candidate : null;
            if (!id) { unknown[month] = (unknown[month] || 0) + partition.count; if (!candidate) continue; }
            const sourceId = id || candidate, identity = JSON.stringify([sourceId, month]);
            if (!digests.has(identity)) digests.set(identity, []);
            digests.get(identity).push([partition.key, partition.digest, partition.count]);
            for (const runId of partition.runIds) ((runRefs[sourceId] ||= {})[month] ||= new Set()).add(runId);
          }
        } else if (observationIndex) {
          const descriptor = await historyDescriptor();
          malformed = descriptor.malformedLines;
          await observationIndex.readLines({ parseMode: "monthly" }, consume);
        } else {
          const input = readline.createInterface({ input: historyStream(current.paths.history), crlfDelay: Infinity });
          try { for await (const line of input) { if (!line.trim()) continue; let row; try { row = JSON.parse(line.replace(/^\uFEFF/, "")); } catch { malformed++; continue; }
            if (!row || typeof row !== "object" || Array.isArray(row)) { malformed++; continue; }
            consume(line, row);
          } } finally { input.close(); }
        }
        requireValid(signature(await stat(current.paths.history)) === current.metadata.history);
      }
      for (const [identity, digest] of digests) { const [id, month] = JSON.parse(identity); (rows[id] ||= {})[month] = Array.isArray(digest)
        ? hash(digest.sort((a, b) => a[0].localeCompare(b[0]))) : digest.digest("hex"); }
      parts.history = { kind: historyKind, rows, runRefs: Object.fromEntries(Object.entries(runRefs).map(([id, months]) => [id, Object.fromEntries(Object.entries(months).map(([month, ids]) => [month, [...ids].sort()]))])), unknown, malformed };
    }
    // Context is indexed by the saved response's own region/month. Unknown
    // cache identity stays a conservative shared dependency, never guessed.
    parts.contextFiles ||= {};
    const contextLabels = Object.keys(current.metadata).filter(label => /^(?:tourism|search)\//.test(label));
    for (const label of contextLabels) if (changed(label)) {
      const value = await json(label, current, {}), snapshot = value.snapshot || value, rawMonth = snapshot.yearMonth || snapshot.month || label.match(/(\d{4})(\d{2})[.]json$/)?.slice(1).join("-") || "";
      const month = /^\d{4}(0[1-9]|1[0-2])$/.test(rawMonth) ? rawMonth.slice(0, 4) + "-" + rawMonth.slice(4) : rawMonth;
      const regions = [...new Set([snapshot.regionKey, snapshot.region?.regionKey, ...(snapshot.allRegions || snapshot.regions || []).map(region => region.regionKey)].filter(Boolean))];
      parts.contextFiles[label] = { month: monthValid(month) ? month : "", regions, digest: contentDigests[label] };
    }
    for (const label of Object.keys(parts.contextFiles)) if (!contextLabels.includes(label)) delete parts.contextFiles[label];
    const engines = Object.keys(parts).filter(key => key.startsWith("engine/")).sort().map(key => parts[key].digest);
    const common = hash([VERSION, engines, calculationFingerprint, parts.regions?.digest, parts["tourism-map"]?.digest, parts.history.malformed, conflicts.size]);
    const context = { monthly: {}, years: {}, unknown: [] };
    for (const label of Object.keys(parts.contextFiles).sort()) {
      const entry = parts.contextFiles[label];
      if (!entry.month || !entry.regions.length) { context.unknown.push(entry.digest); continue; }
      for (const regionKey of entry.regions) (((context.monthly[regionKey] ||= {})[entry.month] ||= [])).push(entry.digest);
    }
    for (const [label, value] of Object.entries(contentDigests)) if (label.startsWith("calendar/")) { const year = label.match(/\d{4}/)?.[0]; if (year) (context.years[year] ||= []).push([label, value]); else context.unknown.push([label, value]); }
    const companies = {}, runMetadataById = {};
    for (const [label, value] of Object.entries(contentDigests)) if (label.startsWith("runs/")) (runMetadataById[label.split("/")[1]] ||= []).push([label, value]);
    parts.runCatalog ||= {};
    const knownRuns = [...new Set(Object.values(parts.master.companies).flatMap(company => company.knownRuns))];
    for (const id of knownRuns) {
      const metadata = (runMetadataById[id] || []).sort(), revision = hash(metadata);
      if (parts.runCatalog[id]?.revision === revision) continue;
      const manifest = await json("runs/" + id + "/manifest.json", current, {}), start = monthOf(manifest.checkIn), observed = collectedMonth(manifest.collectedAt);
      const lower = [start, observed].filter(Boolean).sort().at(-1) || "", span = Number(manifest.bookingRangeDays);
      const last = start && Number.isSafeInteger(span) && span > 0 && span <= 366 ? new Date(Date.parse(manifest.checkIn + "T00:00:00Z") + (span - 1) * 86400000).toISOString().slice(0, 7) : "";
      parts.runCatalog[id] = { revision, lower, upper: last, observed };
    }
    for (const id of Object.keys(parts.runCatalog)) if (!knownRuns.includes(id)) delete parts.runCatalog[id];
    for (const [id, company] of Object.entries(parts.master.companies)) {
      const kosis = company.regionId ? crypto.createHash("sha256").update(company.regionId).digest("hex").slice(0, 24) : "";
      const revision = hash([common, company.meta, company.identity, parts.capacity[id] || null, context.unknown, includeContext && kosis ? [contentDigests["kosis/" + kosis + ".json"], contentDigests["kosis/" + kosis + "-attempt.json"]] : null]);
      const months = {}, allMonths = [...new Set([...Object.keys(company.months), ...Object.keys(parts.history.rows[id] || {})])];
      for (const month of allMonths) { const runIds = [...new Set([...(company.runs[month] || []), ...(parts.history.runRefs[id]?.[month] || [])])].sort();
        const runMetadata = runIds.flatMap(runId => runMetadataById[runId] || []).sort();
        months[month] = hash([company.months[month] || null, parts.history.rows[id]?.[month] || null, runMetadata]); }
      companies[id] = { revision, months, regionKey: company.regionKey, runs: company.knownRuns.map(runId => parts.runCatalog[runId]) };
    }
    const unknownMonths = { ...parts.history.unknown }; for (const [month, count] of Object.entries(parts.master.fallbackUnknown || {})) unknownMonths[month] = (unknownMonths[month] || 0) + count;
    const prepared = { version: VERSION, revision: hash([common, companies, context, unknownMonths]), companies, context, unknownMonths };
    // A second fresh metadata scan prevents a partial inventory/history from
    // certifying a source that changed while the index was being rebuilt.
    requireValid(hash((await inventory()).metadata) === hash(current.metadata));
    const body = { version: VERSION, configuration, metadata: current.metadata, contentDigests, parts, prepared }; await atomic({ ...body, checksum: hash(body) }); return structuredClone(prepared);
  }
  function forScope(prepared, { companyId, month, cutoffDate = "", calculationVersion = "" } = {}) {
    requireValid(prepared?.version === VERSION && prepared.companies && monthValid(month) && typeof companyId === "string");
    const company = prepared.companies[companyId]; requireValid(company && /^[a-f0-9]{64}$/.test(company.revision));
    const months = [month, previousMonth(month)], years = [...new Set(months.flatMap(value => [value.slice(0, 4), ...(value.endsWith("-12") ? [String(Number(value.slice(0, 4)) + 1)] : [])]))];
    return hash([VERSION, calculationVersion, company.revision, months.map(value => [value, company.months[value] || null,
      prepared.unknownMonths[value] || 0, prepared.context.monthly[company.regionKey]?.[value] || null,
      company.runs.filter(run => value === run.observed || (!run.lower || value >= run.lower) && (!run.upper || value <= run.upper))]), years.map(year => prepared.context.years[year] || null), cutoffDate]);
  }
  const prepare = () => { const task = chain.then(scan).catch(error => { throw error?.code?.startsWith("COMPANY_SOURCE_REVISION") ? error : fault("COMPANY_SOURCE_REVISION_UNAVAILABLE"); }); chain = task.catch(() => {}); return task; };
  const reader = async scope => forScope(await prepare(), scope); reader.prepare = prepare; reader.forScope = forScope; return reader;
}
module.exports = { createCompanyIntegratedSourceRevision, VERSION };
