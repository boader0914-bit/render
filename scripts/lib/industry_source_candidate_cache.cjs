"use strict";

// Disposable completed source candidates. Raw observations and issued reports
// have separate owners. Immutable bounded shards become visible by one pointer.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { gzipSync, gunzipSync, constants } = require("node:zlib");
const { compactProductCapacityEvidence } = require("./product_capacity_baseline.cjs");
const { isCooperativeWorkYield } = require("./cooperative_work_checkpoint.cjs");
const hash = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const stable = value => value && typeof value === "object" ? Array.isArray(value) ? value.map(stable)
  : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const ownKeys = function* (value) { for (const key in value) if (Object.hasOwn(value, key)) yield key; };
function fitsSerialized(value, limit) {
  // Traverse one child at a time, without copying a large input's key/row list.
  const stack = [{ kind: "value", value }], ancestors = new WeakSet(); let bytes = 0;
  while (stack.length) {
    const frame = stack.pop(), current = frame.value;
    if (frame.kind === "exit") { ancestors.delete(current); continue; }
    if (frame.kind === "array") {
      if (frame.index < current.length) { const child = current[frame.index++]; stack.push(frame, { kind: "value", value: child }); }
      continue;
    }
    if (frame.kind === "object") {
      const key = frame.keys.next();
      if (!key.done) { bytes += Buffer.byteLength(JSON.stringify(key.value)) + 2; stack.push(frame, { kind: "value", value: current[key.value] }); }
    } else if (!current || typeof current !== "object") {
      if (typeof current === "string" && current.length > limit) return false;
      bytes += Buffer.byteLength(JSON.stringify(current) ?? "null");
    } else {
      if (ancestors.has(current)) return false;
      ancestors.add(current); bytes += 2; stack.push({ kind: "exit", value: current });
      stack.push(Array.isArray(current) ? { kind: "array", value: current, index: 0 } : { kind: "object", value: current, keys: ownKeys(current) });
      if (Array.isArray(current)) bytes += Math.max(0, current.length - 1);
    }
    if (bytes > limit) return false;
  }
  return true;
}
function witnessProfile(evidence) {
  return compactProductCapacityEvidence(evidence)
    .map(row => Object.fromEntries(["companyId", "productType", "productId", "count", "collectedAt", "sourceDate", "runId", "source"]
      .map(key => [key, row[key] ?? ""]))).sort((a, b) => JSON.stringify(stable(a)).localeCompare(JSON.stringify(stable(b))));
}
function witnessInputsMatch(before, publicationEvidence, fresh, cutoffDate) {
  if (!before || !Array.isArray(before.companyIds) || new Set(before.companyIds).size !== before.companyIds.length
    || ![before.evidence, before.warnings, publicationEvidence, fresh?.evidence, fresh?.warnings].every(Array.isArray)
    || !/^\d{4}-\d{2}-\d{2}$/.test(cutoffDate || "") || !Number.isFinite(Date.parse(`${cutoffDate}T23:59:59.999+09:00`))) return false;
  const ids = new Set(before.companyIds);
  const boundary = Date.parse(`${cutoffDate}T23:59:59.999+09:00`);
  // Group once. An industry can contain hundreds of companies and many dated
  // witnesses; never scan or clone every company's witnesses for each company.
  function group(rows, temporal) {
    const groups = new Map();
    for (const row of rows) {
      if (!ids.has(row?.companyId)) return null;
      if (temporal) { const at = Date.parse(row.collectedAt); if (!Number.isFinite(at) || at > boundary) continue; }
      let values = groups.get(row.companyId); if (!values) groups.set(row.companyId, values = []); values.push(row);
    }
    return groups;
  }
  const priorGroups = group(before.evidence, true), publicationGroups = group(publicationEvidence, true), freshGroups = group(fresh.evidence, true);
  const priorWarnings = group(before.warnings, false), freshWarnings = group(fresh.warnings, false);
  if (![priorGroups, publicationGroups, freshGroups, priorWarnings, freshWarnings].every(Boolean)) return false;
  const warnings = rows => rows.map(row => JSON.stringify(stable(row))).sort();
  for (const id of before.companyIds) {
    if (!same(warnings(priorWarnings.get(id) || []), warnings(freshWarnings.get(id) || []))) return false;
    const priorRows = priorGroups.get(id) || [], additionRows = publicationGroups.get(id) || [];
    const prior = witnessProfile(priorRows), current = witnessProfile(freshGroups.get(id) || []);
    const after = witnessProfile(priorRows.concat(additionRows));
    // Each company file is atomic: a partial own publication leaves either its
    // verified input or that exact output. Full temporal highs protect old days.
    if (!same(current, prior) && !same(current, after)) return false;
  }
  return true;
}

function createIndustrySourceCandidateCache({ directory, version, maxEntryBytes = 6 * 1024 * 1024,
  maxBytes = 64 * 1024 * 1024, maxEntries = 4, maxDecodedBytes = 512 * 1024 * 1024 } = {}) {
  if (!directory || typeof version !== "string" || !version || version.length > 1024
    || ![maxEntryBytes, maxBytes, maxEntries, maxDecodedBytes].every(value => Number.isSafeInteger(value) && value > 0)
    || maxEntryBytes > maxBytes || maxEntryBytes > maxDecodedBytes) throw TypeError("Invalid industry source candidate cache");
  directory = path.resolve(directory);
  const metrics = { reads: 0, hits: 0, misses: 0, semanticMisses: 0, acceptedHits: 0, writes: 0, writeFailures: 0,
    oversizeSkips: 0, maximumDecodedBytes: 0, maximumPhysicalBytes: 0, encodedBytesWritten: 0, chunksWritten: 0 };
  let serial = Promise.resolve();
  const keyFor = scope => hash(JSON.stringify([version, scope]));
  const pointerFor = key => path.join(directory, key + ".json");
  const generationName = /^[a-f0-9]{64}-generation-[a-f0-9]{32}$/;
  const over = () => Object.assign(Error("Candidate budget exceeded"), { code: "INDUSTRY_CANDIDATE_TOO_LARGE" });
  const validGeneration = (value, key) => typeof value === "string" && generationName.test(value) && value.startsWith(key + "-generation-");
  async function safeRoot() {
    const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Candidate root invalid");
  }
  async function boundedRead(file, limit) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw Error("Candidate file invalid");
    const bytes = await fs.readFile(file); if (bytes.length > limit) throw over(); return bytes;
  }
  async function pointer(key) {
    const value = JSON.parse(await boundedRead(pointerFor(key), maxEntryBytes)), { checksum, ...body } = value;
    if (body.schemaVersion !== 2 || checksum !== hash(body) || !validGeneration(body.generation, key)) throw Error("Candidate pointer invalid");
    return body;
  }
  async function read(scope, sourceRevision, { checkpoint = async () => {} } = {}) {
    metrics.reads++;
    let checkpointFailed = false, checkpointFailure;
    try {
      await safeRoot();
      const key = keyFor(scope), link = await pointer(key);
      if (link.version !== version || !same(link.scope, scope) || !sourceRevision || link.sourceRevision !== sourceRevision) throw Error("Candidate scope changed");
      const base = path.join(directory, link.generation), stat = await fs.lstat(base);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Candidate directory invalid");
      const bytes = await boundedRead(path.join(base, "manifest.json"), maxEntryBytes);
      if (hash(bytes) !== link.manifestHash) throw Error("Candidate manifest invalid");
      const manifest = JSON.parse(bytes);
      if (manifest.schemaVersion !== 2 || !same(manifest.scope, scope) || manifest.version !== version || manifest.sourceRevision !== sourceRevision
        || !manifest.scaffold || !Array.isArray(manifest.arrays) || manifest.arrays.length > 1000) throw Error("Candidate manifest invalid");
      const candidate = manifest.scaffold, paths = new Set(); let physical = bytes.length, chunks = 0, totalDecoded = bytes.length, totalRows = 0;
      for (const group of manifest.arrays) {
        if (!Array.isArray(group.path) || group.path.length < 1 || group.path.length > 2
          || group.path.some(key => typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))
          || paths.has(JSON.stringify(group.path)) || !Array.isArray(group.files)) throw Error("Candidate array invalid");
        paths.add(JSON.stringify(group.path)); let target = candidate;
        for (const key of group.path.slice(0, -1)) { if (!Object.hasOwn(target, key) || !target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) throw Error("Candidate path invalid"); target = target[key]; }
        const field = group.path.at(-1); if (!Object.hasOwn(target, field) || target[field] !== null) throw Error("Candidate placeholder invalid");
        target[field] = [];
        for (const file of group.files) {
          try { await checkpoint(); } catch (error) { checkpointFailed = true; checkpointFailure = error; throw error; }
          if (!/^chunk-\d+-\d+\.json\.gz$/.test(file.name || "") || !Number.isSafeInteger(file.count) || file.count < 0
            || !Number.isSafeInteger(file.decodedBytes) || file.decodedBytes < 2 || file.decodedBytes > maxEntryBytes || ++chunks > 100000) throw Error("Candidate chunk invalid");
          totalDecoded += file.decodedBytes; if (totalDecoded > maxDecodedBytes) throw over();
          totalRows += file.count; if (totalRows > 1000000) throw over();
          const encoded = await boundedRead(path.join(base, file.name), maxEntryBytes);
          physical += encoded.length; if (physical > maxBytes) throw over();
          const decoded = gunzipSync(encoded, { maxOutputLength: maxEntryBytes });
          metrics.maximumDecodedBytes = Math.max(metrics.maximumDecodedBytes, decoded.length);
          if (decoded.length !== file.decodedBytes || hash(decoded) !== file.hash) throw Error("Candidate chunk corrupt");
          const rows = JSON.parse(decoded); if (!Array.isArray(rows) || rows.length !== file.count) throw Error("Candidate chunk count invalid");
          for (const row of rows) target[field].push(row);
        }
      }
      await fs.utimes(pointerFor(key), new Date(), new Date()).catch(() => {});
      metrics.hits++; return candidate;
    } catch (error) { if (checkpointFailed && error === checkpointFailure || isCooperativeWorkYield(error)) throw error; metrics.misses++; return null; }
  }
  async function removeGeneration(name) {
    if (!generationName.test(name)) return;
    const file = path.resolve(directory, name); if (path.dirname(file) !== directory) throw Error("Candidate cleanup scope invalid");
    await safeRoot();
    const stat = await fs.lstat(file).catch(() => null);
    if (stat?.isDirectory() && !stat.isSymbolicLink()) await fs.rm(file, { recursive: true, force: true });
  }
  async function inventory() {
    const names = await fs.readdir(directory), links = [], generations = [];
    for (const name of names) {
      if (/^[a-f0-9]{64}\.json$/.test(name)) {
        const stat = await fs.lstat(path.join(directory, name)).catch(() => null);
        if (stat?.isFile() && !stat.isSymbolicLink()) {
          let value; try { value = await pointer(name.slice(0, 64)); } catch {}
          links.push({ key: name.slice(0, 64), size: stat.size, at: stat.mtimeMs, generation: value?.generation });
        }
      } else if (generationName.test(name)) generations.push(name);
    }
    return { links, generations };
  }
  async function generationBytes(name) {
    const base = path.join(directory, name), stat = await fs.lstat(base).catch(() => null); if (!stat?.isDirectory() || stat.isSymbolicLink()) return 0;
    let bytes = 0;
    for (const file of await fs.readdir(base)) { const child = await fs.lstat(path.join(base, file)); if (!child.isFile() || child.isSymbolicLink()) throw Error("Candidate generation invalid"); bytes += child.size; }
    return bytes;
  }
  async function writeOwned(scope, sourceRevision, candidate, { checkpoint = async () => {} } = {}) {
    const key = keyFor(scope), generation = `${key}-generation-${crypto.randomUUID().replaceAll("-", "")}`;
    let temporary, published = false, totalDecoded = 0, totalRows = 0, checkpointFailed = false, checkpointFailure;
    try {
      await fs.mkdir(directory, { recursive: true });
      await safeRoot();
      const existing = await inventory(), protectedNames = new Set(existing.links.map(row => row.generation).filter(Boolean));
      for (const name of existing.generations) if (!protectedNames.has(name)) await removeGeneration(name);
      let physical = existing.links.reduce((sum, row) => sum + row.size, 0);
      for (const name of protectedNames) physical += await generationBytes(name);
      const evictable = existing.links.filter(row => row.key !== key).sort((a, b) => a.at - b.at);
      let linkCount = existing.links.length;
      async function reserve(bytes) {
        while ((physical + bytes > maxBytes || linkCount + (existing.links.some(row => row.key === key) ? 0 : 1) > maxEntries) && evictable.length) {
          const old = evictable.shift(); await fs.unlink(pointerFor(old.key)); physical -= old.size; linkCount--;
          if (old.generation) { physical -= await generationBytes(old.generation); await removeGeneration(old.generation); }
        }
        if (physical + bytes > maxBytes) throw over(); physical += bytes;
        metrics.maximumPhysicalBytes = Math.max(metrics.maximumPhysicalBytes, physical);
      }
      const base = path.join(directory, generation); await fs.mkdir(base);
      async function writeFile(name, bytes) {
        await reserve(bytes.length); const handle = await fs.open(path.join(base, name), "wx");
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      }
      const scaffold = { ...candidate }, arrays = [];
      for (const groupKey of [null, "source", "persistedProductCapacityInput"]) {
        const original = groupKey === null ? candidate : candidate[groupKey];
        if (!original || typeof original !== "object" || Array.isArray(original)) continue;
        const target = groupKey === null ? scaffold : scaffold[groupKey] = { ...original };
        for (const field of Object.keys(original)) if (Array.isArray(original[field])) {
          totalRows += original[field].length; if (totalRows > 1000000) throw over();
          const group = { path: groupKey === null ? [field] : [groupKey, field], files: [] }; arrays.push(group); target[field] = null;
          let units = [], bytes = 2;
          const flush = async () => {
            if (!units.length) return;
            try { await checkpoint(); } catch (error) { checkpointFailed = true; checkpointFailure = error; throw error; }
            const decoded = "[" + units.join(",") + "]", encoded = gzipSync(decoded, { level: constants.Z_BEST_SPEED });
            totalDecoded += Buffer.byteLength(decoded); if (totalDecoded > maxDecodedBytes) throw over();
            const name = `chunk-${metrics.chunksWritten}-${crypto.randomBytes(4).readUInt32BE(0)}.json.gz`;
            if (encoded.length > maxEntryBytes) throw over();
            await writeFile(name, encoded); group.files.push({ name, count: units.length, decodedBytes: Buffer.byteLength(decoded), hash: hash(decoded) });
            metrics.maximumDecodedBytes = Math.max(metrics.maximumDecodedBytes, Buffer.byteLength(decoded));
            metrics.encodedBytesWritten += encoded.length; metrics.chunksWritten++; units = []; bytes = 2;
          };
          for (const row of original[field]) {
            if (!fitsSerialized(row, maxEntryBytes - 2)) throw over();
            const encoded = JSON.stringify(row) ?? "null", count = Buffer.byteLength(encoded);
            if (bytes + count + (units.length ? 1 : 0) > maxEntryBytes) await flush();
            units.push(encoded); bytes += count + (units.length > 1 ? 1 : 0);
          }
          await flush();
        }
      }
      const manifest = { schemaVersion: 2, version, scope, sourceRevision, scaffold, arrays };
      if (!fitsSerialized(manifest, maxEntryBytes)) throw over();
      const manifestBytes = Buffer.from(JSON.stringify(manifest)); if (manifestBytes.length > maxEntryBytes) throw over();
      if (totalDecoded + manifestBytes.length > maxDecodedBytes) throw over();
      await writeFile("manifest.json", manifestBytes);
      const body = { schemaVersion: 2, version, scope, sourceRevision, generation, manifestHash: hash(manifestBytes) };
      const pointerBytes = JSON.stringify({ ...body, checksum: hash(body) }); await reserve(Buffer.byteLength(pointerBytes));
      temporary = `${pointerFor(key)}.${crypto.randomUUID()}.tmp`;
      const handle = await fs.open(temporary, "wx"); try { await handle.writeFile(pointerBytes); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, pointerFor(key)); published = true; metrics.writes++;
      const prior = existing.links.find(row => row.key === key); if (prior?.generation) await removeGeneration(prior.generation).catch(() => {});
      return true;
    } catch (error) {
      // A lost rename acknowledgement must not remove a generation that is
      // already the complete published pointer's target.
      try { if ((await pointer(key)).generation === generation) published = true; } catch {}
      if (checkpointFailed && error === checkpointFailure || isCooperativeWorkYield(error)) throw error;
      if (error.code === "INDUSTRY_CANDIDATE_TOO_LARGE") metrics.oversizeSkips++; else metrics.writeFailures++;
      return published;
    }
    finally { if (temporary) await fs.unlink(temporary).catch(() => {}); if (!published) await removeGeneration(generation).catch(() => {}); }
  }
  function write(scope, sourceRevision, candidate, options) { const pending = serial.then(() => writeOwned(scope, sourceRevision, candidate, options)); serial = pending.then(() => undefined, () => undefined); return pending; }
  return { read, write, semanticMiss: () => { metrics.semanticMisses++; }, accept: () => { metrics.acceptedHits++; }, stats: () => ({ ...metrics }) };
}

module.exports = { createIndustrySourceCandidateCache, witnessInputsMatch };
