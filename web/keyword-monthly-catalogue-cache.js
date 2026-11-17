(function (root) {
  "use strict";
  const KEY = "staydatalab:keyword-monthly-catalogue:v1", MAX_BYTES = 64 * 1024, TTL_MS = 5 * 60000;
  const SHA = /^[a-f0-9]{64}$/, MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
  const sha = v => typeof v === "string" && SHA.test(v);
  const plain = v => v && typeof v === "object" && !Array.isArray(v);
  const exact = (v, fields) => plain(v) && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
  const text = v => typeof v === "string" && v.length > 0 && v.length <= 300 && v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v);
  const day = v => typeof v === "string" && /^20\d{2}-\d\d-\d\d$/.test(v) && Number.isFinite(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
  const iso = v => typeof v === "string" && /^20\d{2}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(v)
    && day(v.slice(0, 10)) && Number.isFinite(Date.parse(v));
  const kstDay = at => new Date(at + 9 * 3600000).toISOString().slice(0, 10);
  function validMetadata(v) {
    if (!exact(v, ["currentDay", "revision", "generation", "keywords"]) || !day(v.currentDay) || !sha(v.revision)
      || typeof v.generation !== "string" || !/^[a-f0-9]{32}$/.test(v.generation) || !Array.isArray(v.keywords) || !v.keywords.length || v.keywords.length > 128) return false;
    const words = new Set(); let scopes = 0;
    for (const row of v.keywords) {
      if (!exact(row, ["keyword", "stayMonths", "supportedCutoffs", "dataThroughByMonth"]) || !text(row.keyword) || words.has(row.keyword)
        || !Array.isArray(row.stayMonths) || !row.stayMonths.length || row.stayMonths.length > 120 || row.stayMonths.some(m => typeof m !== "string" || !MONTH.test(m))
        || new Set(row.stayMonths).size !== row.stayMonths.length || !plain(row.supportedCutoffs) || !plain(row.dataThroughByMonth)) return false;
      words.add(row.keyword); scopes += row.stayMonths.length; if (scopes > 512) return false;
      for (const [month, cutoff] of Object.entries(row.supportedCutoffs)) if (!row.stayMonths.includes(month) || !day(cutoff) || cutoff > v.currentDay) return false;
      for (const [month, through] of Object.entries(row.dataThroughByMonth)) if (!row.stayMonths.includes(month) || !iso(through)) return false;
    }
    return true;
  }
  function projectCatalogue(value) {
    if (!plain(value) || value.schemaVersion !== 1 || value.status !== "available" || value.readOnly !== true || value.networkAttempted !== false
      || value.provenance?.originalFreshnessVerified !== false || !Array.isArray(value.keywords) || !value.keywords.length || value.keywords.length > 128
      || (value.diagnostics != null && (!Array.isArray(value.diagnostics) || value.diagnostics.length !== 0))
      || (value.bundle?.unavailablePartitions != null && (!Array.isArray(value.bundle.unavailablePartitions) || value.bundle.unavailablePartitions.length !== 0))
      || value.keywords.some(row => row?.availabilityByMonth != null && (!plain(row.availabilityByMonth) || Object.values(row.availabilityByMonth).some(status => status !== "available")))) return null;
    const metadata = { currentDay: value.currentDay, revision: value.provenance?.currentPointerSha256, generation: value.bundle?.generation,
      keywords: value.keywords.map(row => ({ keyword: row?.keyword, stayMonths: row?.stayMonths,
        supportedCutoffs: row?.supportedCutoffs == null ? {} : row.supportedCutoffs,
        dataThroughByMonth: Object.fromEntries(Object.entries(plain(row?.provenanceByMonth) ? row.provenanceByMonth : {})
          .filter(([, item]) => iso(item?.dataThrough)).map(([month, item]) => [month, item.dataThrough])) })) };
    if (!validMetadata(metadata)) return null;
    return JSON.parse(JSON.stringify(metadata));
  }
  function createCatalogueCache({ storage, now = Date.now } = {}) {
    let authorization = null;
    const clear = () => { try { storage?.removeItem(KEY); } catch {} };
    const revoke = () => { authorization = null; clear(); };
    function configure(value) {
      const at = Number(now());
      if (!exact(value, ["authenticated", "scope", "expiresAt"]) || value.authenticated !== true || !sha(value.scope)
        || !Number.isFinite(value.expiresAt) || !Number.isFinite(at) || value.expiresAt <= at) { revoke(); return false; }
      if (authorization && authorization.scope !== value.scope) clear();
      authorization = { scope: value.scope, expiresAt: value.expiresAt }; return true;
    }
    function authorized() {
      const at = Number(now());
      if (!authorization || !Number.isFinite(at) || at >= authorization.expiresAt) { revoke(); return false; }
      return true;
    }
    function read() {
      if (!authorized()) return null;
      try {
        const raw = storage?.getItem(KEY);
        if (!raw) return null;
        if (raw.length > MAX_BYTES || new root.TextEncoder().encode(raw).byteLength > MAX_BYTES) { clear(); return null; }
        const entry = JSON.parse(raw), at = Number(now());
        if (!exact(entry, ["schema", "scope", "storedAt", "expiresAt", "metadata"]) || entry.schema !== 1 || entry.scope !== authorization.scope
          || !Number.isFinite(entry.storedAt) || entry.storedAt > at || at - entry.storedAt > TTL_MS || !Number.isFinite(entry.expiresAt)
          || entry.expiresAt <= at || entry.expiresAt > authorization.expiresAt || entry.expiresAt > entry.storedAt + TTL_MS
          || !validMetadata(entry.metadata) || entry.metadata.currentDay !== kstDay(at)) { clear(); return null; }
        return entry.metadata;
      } catch { clear(); return null; }
    }
    function write(value) {
      if (!authorized()) return false;
      const metadata = projectCatalogue(value), at = Number(now());
      if (!metadata || metadata.currentDay !== kstDay(at)) return false;
      try {
        const raw = JSON.stringify({ schema: 1, scope: authorization.scope, storedAt: at, expiresAt: Math.min(authorization.expiresAt, at + TTL_MS), metadata });
        if (raw.length > MAX_BYTES || new root.TextEncoder().encode(raw).byteLength > MAX_BYTES || typeof storage?.setItem !== "function") return false;
        storage.setItem(KEY, raw); return true;
      } catch { return false; }
    }
    return { configure, read, write, clear, revoke };
  }
  function catalogueForVersion(metadata, version) {
    if (!validMetadata(metadata) || !plain(version) || version.schemaVersion !== 1 || version.status !== "available"
      || version.readOnly !== true || version.networkAttempted !== false || version.originalFreshnessVerified !== false
      || version.revision !== metadata.revision || version.generation !== metadata.generation || version.currentDay !== metadata.currentDay) return null;
    return { schemaVersion: 1, status: "available", readOnly: true, networkAttempted: false, currentDay: version.currentDay, currentMonth: version.currentDay.slice(0, 7),
      keywords: metadata.keywords.map(row => ({ keyword: row.keyword, stayMonths: [...row.stayMonths], collectionMonths: [], supportedCutoffs: { ...row.supportedCutoffs },
        defaultCutoffs: { ...row.supportedCutoffs }, provenanceByMonth: Object.fromEntries(Object.entries(row.dataThroughByMonth).map(([month, dataThrough]) => [month, { dataThrough }])) })),
      provenance: { currentPointerSha256: version.revision, originalFreshnessVerified: false }, bundle: { generation: version.generation }, diagnostics: [], refreshStatus: null };
  }
  const api = { createCatalogueCache, projectCatalogue, validMetadata, catalogueForVersion, KEY, MAX_BYTES, TTL_MS };
  root.KeywordMonthlyCatalogueCache = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
