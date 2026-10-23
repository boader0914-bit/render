"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { createScheduledSingleFlight } = require("./scheduled_single_flight.cjs");

// These are evidence collections, not list-view aggregates. They remain in the
// existing detail response and on disk; the read model never edits the source.
const DETAIL_ARRAY_FIELDS = new Set([
  "daily", "products", "rooms", "snapshots", "phonePriceEstimates", "observations",
  "evidence", "exclusionEvidence", "normalizationEvidence", "priceEstimates",
  "sourceRows", "rawRows", "inventoryRows", "weeklyProductDetails"
]);

function aggregateFields(value, key = "") {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (DETAIL_ARRAY_FIELDS.has(key)) return undefined;
    // Flags/channel names and the four weekday aggregates are small and affect
    // filters/review counts. Preserve them, including a genuine zero/null.
    return value.map(row => aggregateFields(row)).filter(row => row !== undefined);
  }
  const result = {};
  for (const [name, entry] of Object.entries(value)) {
    if ((DETAIL_ARRAY_FIELDS.has(name) && entry && typeof entry === "object") || /History$/.test(name)) continue;
    const projected = aggregateFields(entry, name);
    if (projected !== undefined) result[name] = projected;
  }
  return result;
}

function textFromValues(value, output = []) {
  if (value === null || value === undefined) return output;
  if (Array.isArray(value)) { for (const row of value) textFromValues(row, output); }
  else if (typeof value === "object") { for (const row of Object.values(value)) textFromValues(row, output); }
  else output.push(String(value));
  return output;
}

function compactCompanyInventory(inventory = {}) {
  const snapshot = value => {
    if (!value || typeof value !== "object") return value || null;
    const result = aggregateFields(value);
    // Feature discovery used to inspect these optional raw list fields. Keep
    // only the matched feature vocabulary, not all room/product evidence.
    const text = textFromValues([value.rooms, value.products, value.facilities]).join(" ");
    const features = text.match(/수영장|풀장|온수풀|개별풀|개별수영장|인피니티풀|세미나|회의실|연회장|워크샵|워크숍|단체실|애견|반려견|반려동물|펫|바베큐|바비큐|bbq|숯불|그릴/gi);
    if (features?.length) result._bootstrapFeatureText = [...new Set(features)].join(" ");
    return result;
  };
  const latest = inventory.latest;
  const previous = inventory.previousLatest || (inventory.snapshots || []).find(row =>
    (row?.runId || row?.collectedAt) !== (latest?.runId || latest?.collectedAt));
  const result = aggregateFields(inventory);
  result.latest = snapshot(latest);
  result.previousLatest = snapshot(previous);
  result.snapshots = [];
  return result;
}

function fingerprint(stat) {
  return crypto.createHash("sha256").update(JSON.stringify([
    String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs ?? stat.mtimeMs), String(stat.ctimeNs ?? stat.ctimeMs)
  ])).digest("hex");
}

function sourceChangedError() {
  const error = new Error("업체 기본자료가 변경되고 있습니다. 다시 조회해 주세요.");
  error.code = "COMPANY_BOOTSTRAP_SOURCE_CHANGED";
  error.statusCode = 503;
  return error;
}

function missingSourceError() {
  const error = new Error("기존 업체 기본자료 파일을 찾지 못했습니다. 저장소 연결 상태를 확인해 주세요.");
  error.code = "COMPANY_BOOTSTRAP_SOURCE_MISSING";
  error.statusCode = 503;
  return error;
}

function acceptsGzip(header = "") {
  return String(header).split(",").some(entry => {
    const [encoding, ...parameters] = entry.trim().split(";");
    if (encoding.trim().toLowerCase() !== "gzip") return false;
    const q = parameters.find(parameter => /^\s*q\s*=/i.test(parameter));
    return q === undefined || Number(q.split("=")[1]) > 0;
  });
}

function dataHash(data) { return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex"); }

function createCompanyBootstrapStore({ sourceFile, cacheFile, projectionVersion, project, emptyMaster, fileSystem = fs,
  runWork = operation => operation() }) {
  let memory = null;
  const flight = createScheduledSingleFlight({ runWork, kind: "company-bootstrap" });
  const flightKey = "bootstrap";
  let epoch = 0;
  let knownSource = false;
  const signature = async () => {
    try {
      const stat = await fileSystem.stat(sourceFile, { bigint: true });
      knownSource = true;
      return fingerprint(stat);
    }
    catch (error) {
      if (error.code === "ENOENT") { if (knownSource) throw missingSourceError(); return "missing"; }
      throw error;
    }
  };
  function encoded(data, sourceSignature) {
    const json = Buffer.from(JSON.stringify(data));
    return { data, sourceSignature, json, gzip: zlib.gzipSync(json, { level: 4 }) };
  }
  async function load() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedEpoch = epoch;
      const sourceSignature = await signature();
      if (memory?.sourceSignature === sourceSignature) return { ...memory, cacheStatus: "memory" };
      let saved = null;
      try { saved = JSON.parse(await fileSystem.readFile(cacheFile, "utf8")); }
      catch { /* A corrupt/unreadable derived cache can be rebuilt from source. */ }
      if (sourceSignature === "missing" && saved?.sourceSignature && saved.sourceSignature !== "missing"
        && saved.data?.representation === "bootstrap" && saved.dataHash === dataHash(saved.data)) {
        knownSource = true;
        throw missingSourceError();
      }
      if (saved) {
        if (saved.projectionVersion === projectionVersion && saved.sourceSignature === sourceSignature
          && saved.data?.representation === "bootstrap" && Array.isArray(saved.data.companies)
          && saved.dataHash === dataHash(saved.data)) {
          if (startedEpoch !== epoch || await signature() !== sourceSignature) continue;
          memory = encoded(saved.data, sourceSignature);
          return { ...memory, cacheStatus: "saved" };
        }
      }
      saved = null;
      let master = sourceSignature === "missing" ? emptyMaster() : JSON.parse((await fileSystem.readFile(sourceFile, "utf8")).replace(/^\uFEFF/, ""));
      if (!master || typeof master !== "object" || Array.isArray(master)
        || !master.companies || typeof master.companies !== "object" || Array.isArray(master.companies)) {
        const error = new Error("업체 기본자료를 읽지 못했습니다.");
        error.code = "COMPANY_BOOTSTRAP_INVALID_SOURCE";
        throw error;
      }
      const projected = await project(master);
      master = null;
      const data = { ...projected, representation: "bootstrap", sourceRevision: sourceSignature };
      if (startedEpoch !== epoch || await signature() !== sourceSignature) continue;
      const next = encoded(data, sourceSignature);
      const temp = `${cacheFile}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
      try {
        await fileSystem.mkdir(path.dirname(cacheFile), { recursive: true });
        await fileSystem.writeFile(temp, JSON.stringify({ projectionVersion, sourceSignature, dataHash: dataHash(data), data }), { mode: 0o600, flag: "wx" });
        if (startedEpoch !== epoch || await signature() !== sourceSignature) { await fileSystem.unlink(temp); continue; }
        await fileSystem.rename(temp, cacheFile);
      } catch {
        // A full/read-only cache volume still allows the correctly calculated
        // response. The source is never rewritten or removed here.
        await fileSystem.unlink(temp).catch(() => {});
      }
      if (startedEpoch !== epoch || await signature() !== sourceSignature) continue;
      memory = next;
      return { ...next, cacheStatus: "calculated" };
    }
    throw sourceChangedError();
  }
  return {
    async get() {
      // A genuine memory hit needs only the existing source stat. Saved-cache
      // parsing and rebuilding always acquire the shared analytical lease.
      if (memory && !flight.has(flightKey)) {
        const cached = memory, startedEpoch = epoch;
        const sourceSignature = await signature();
        if (memory === cached && startedEpoch === epoch && !flight.has(flightKey)
          && cached.sourceSignature === sourceSignature) return { ...cached, cacheStatus: "memory" };
      }
      return flight.run(flightKey, load);
    },
    invalidate() { epoch += 1; memory = null; }
  };
}

module.exports = { aggregateFields, compactCompanyInventory, createCompanyBootstrapStore, acceptsGzip };
