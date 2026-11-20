"use strict";

// Static code/styles only. Authentication remains the caller's existing guard.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), zlib = require("node:zlib");
const { promisify } = require("node:util"), { performance } = require("node:perf_hooks");
const gzip = promisify(zlib.gzip), DIGEST_CHUNK_BYTES = 64 * 1024;
const eligible = pathname => typeof pathname === "string" && /^\/[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:js|css)$/.test(pathname) && pathname !== "/sw.js";
const signature = stat => [stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino, stat.dev].map(String).join(":");
const failed = code => Object.assign(Error("화면 파일을 준비하지 못했습니다. 잠시 후 다시 조회해 주세요."), { code, statusCode: 503 });
function acceptsGzip(value) {
  let explicit, wildcard;
  for (const item of String(value || "").split(",")) {
    const [name, ...parameters] = item.trim().toLowerCase().split(";"); if (!["gzip", "*"].includes(name)) continue;
    const quality = parameters.find(part => /^\s*q\s*=/.test(part)), text = quality?.split("=")[1]?.trim();
    const q = quality === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(text || "") ? Number(text) : 0;
    if (name === "gzip") explicit = q; else wildcard = q;
  }
  return (explicit ?? wildcard ?? 0) > 0;
}
function matchesEtag(header, tag) {
  const normalized = tag.replace(/^W\//, "");
  return typeof header === "string" && header.split(",").some(value => value.trim() === "*" || value.trim().replace(/^W\//, "") === normalized);
}
function createPrivateStaticAssets({ directory, maxFileBytes = 8 * 1024 * 1024, maxCacheBytes = 16 * 1024 * 1024, maxEntries = 64,
  fileSystem = fs, gzipImpl = gzip } = {}) {
  if (!directory || ![maxFileBytes, maxCacheBytes, maxEntries].every(value => Number.isSafeInteger(value) && value > 0)
    || maxFileBytes > maxCacheBytes || maxEntries > 256 || typeof gzipImpl !== "function") throw TypeError("Invalid private static asset cache");
  const root = path.resolve(directory), entries = new Map(), flights = new Map(), digestFlights = new Map();
  let bytes = 0, serial = Promise.resolve(), digestSerial = Promise.resolve();
  const counters = { reads: 0, hits: 0, gzipBuilds: 0, evictions: 0, activeLoads: 0, maximumActiveLoads: 0,
    digestReads: 0, activeDigestLoads: 0, maximumActiveDigestLoads: 0 };
  async function rootValid() { const stat = await fileSystem.lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw failed("STATIC_ASSET_ROOT_INVALID"); }
  async function source(pathname) {
    await rootValid(); const filename = path.join(root, pathname.slice(1));
    try { const stat = await fileSystem.lstat(filename, { bigint: true }); return stat.isFile() && !stat.isSymbolicLink() && stat.size <= BigInt(maxFileBytes) ? { filename, stat } : null; }
    catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw failed("STATIC_ASSET_UNAVAILABLE"); }
  }
  function remember(pathname, entry) {
    const prior = entries.get(pathname); if (prior) bytes -= prior.bytes;
    entries.delete(pathname); entries.set(pathname, entry); bytes += entry.bytes;
    while (bytes > maxCacheBytes || entries.size > maxEntries) { const first = entries.keys().next().value; bytes -= entries.get(first).bytes; entries.delete(first); counters.evictions++; }
  }
  const queuedPaths = () => new Set([...flights.keys(), ...digestFlights.keys()]).size;
  function admit(pathname) {
    if (!flights.has(pathname) && !digestFlights.has(pathname) && queuedPaths() >= maxEntries) throw failed("STATIC_ASSET_BUSY");
  }
  // Response work owns one full raw buffer at a time; its queue retains paths.
  // Digest work is independent, serial, and owns one additional 64KiB buffer.
  async function load(pathname, wantGzip) {
    counters.activeLoads++; counters.maximumActiveLoads = Math.max(counters.maximumActiveLoads, counters.activeLoads);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = await source(pathname); if (!before) return null;
        let entry = entries.get(pathname);
        if (entry?.signature === signature(before.stat) && entry.raw) {
          counters.hits++; remember(pathname, entry);
          if (!wantGzip || entry.gzipReady) return entry;
        } else {
          entry = null;
          let handle, raw;
          try {
            handle = await fileSystem.open(before.filename, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0));
            const opened = await handle.stat({ bigint: true }); if (!opened.isFile() || signature(opened) !== signature(before.stat)) continue;
            const buffer = Buffer.alloc(Number(before.stat.size) + 1); let length = 0;
            while (length < buffer.length) { const part = await handle.read(buffer, length, buffer.length - length, null); if (!part.bytesRead) break; length += part.bytesRead; }
            counters.reads++; raw = buffer.subarray(0, length);
            if (raw.length > maxFileBytes || BigInt(raw.length) !== before.stat.size || signature(await handle.stat({ bigint: true })) !== signature(before.stat)) continue;
          } finally { if (handle) await handle.close(); }
          const after = await source(pathname); if (!after || signature(after.stat) !== signature(before.stat)) continue;
          const digest = crypto.createHash("sha256").update(raw).digest("hex");
          const verified = await source(pathname); if (!verified || signature(verified.stat) !== signature(before.stat)) continue;
          entry = { signature: signature(before.stat), digest, raw, gzip: null, gzipReady: false, bytes: raw.length };
          remember(pathname, entry);
          if (!wantGzip) return entry;
        }
        let compressed = null;
        try { counters.gzipBuilds++; const encoded = await gzipImpl(entry.raw, { level: 4 }); if (Buffer.isBuffer(encoded) && encoded.length < entry.raw.length) compressed = encoded; } catch { /* Freshly checked identity remains available. */ }
        const final = await source(pathname); if (!final || signature(final.stat) !== signature(before.stat)) continue;
        entry = { ...entry, gzip: compressed, gzipReady: true, bytes: entry.raw.length + (compressed?.length || 0) };
        remember(pathname, entry); return entry;
      }
      throw failed("STATIC_ASSET_CHANGED");
    } finally { counters.activeLoads--; }
  }
  async function getOwned(pathname, wantGzip = false) {
    if (!eligible(pathname)) return null;
    const before = await source(pathname); if (!before) return null;
    let cached = entries.get(pathname);
    if (cached?.signature === signature(before.stat) && cached.raw && (!wantGzip || cached.gzipReady)) { counters.hits++; remember(pathname, cached); return cached; }
    cached = null;
    let task = flights.get(pathname);
    if (!task) { admit(pathname); task = serial.then(() => load(pathname, wantGzip)); serial = task.then(() => undefined, () => undefined); flights.set(pathname, task); }
    let entry;
    try { entry = await task; } finally { if (flights.get(pathname) === task) flights.delete(pathname); }
    task = null;
    if (entry && wantGzip && !entry.gzipReady) { entry = null; return getOwned(pathname, true); }
    return entry;
  }
  async function get(pathname, wantGzip = false) {
    try { return await getOwned(pathname, wantGzip); }
    catch (error) { throw /^STATIC_ASSET_[A-Z_]+$/.test(error?.code || "") ? error : failed("STATIC_ASSET_UNAVAILABLE"); }
  }
  async function loadDigest(pathname, timing) {
    counters.activeDigestLoads++; counters.maximumActiveDigestLoads = Math.max(counters.maximumActiveDigestLoads, counters.activeDigestLoads);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = await source(pathname); if (!before) return null;
        let cached = entries.get(pathname);
        if (cached?.signature === signature(before.stat)) { counters.hits++; timing.digestHits++; remember(pathname, cached); return cached.digest; }
        cached = null;
        const hash = crypto.createHash("sha256"); let handle, changed = false, hashMs = 0;
        const readStarted = performance.now();
        try {
          handle = await fileSystem.open(before.filename, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0));
          const opened = await handle.stat({ bigint: true }); if (!opened.isFile() || signature(opened) !== signature(before.stat)) continue;
          counters.digestReads++; timing.digestReads++;
          const buffer = Buffer.alloc(DIGEST_CHUNK_BYTES); let length = 0;
          while (length < Number(before.stat.size)) {
            const part = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.stat.size) - length), null);
            timing.digestBytes += part.bytesRead;
            if (!part.bytesRead) { changed = true; break; }
            const began = performance.now(); hash.update(buffer.subarray(0, part.bytesRead));
            const elapsed = performance.now() - began; hashMs += elapsed; timing.digestHashMs += elapsed; length += part.bytesRead;
          }
          const extra = await handle.read(buffer, 0, 1, null); timing.digestBytes += extra.bytesRead;
          if (extra.bytesRead || changed || signature(await handle.stat({ bigint: true })) !== signature(before.stat)) continue;
        } finally {
          if (handle) await handle.close();
          timing.digestReadMs += Math.max(0, performance.now() - readStarted - hashMs);
        }
        const after = await source(pathname); if (!after || signature(after.stat) !== signature(before.stat)) continue;
        const began = performance.now(), digest = hash.digest("hex"); timing.digestHashMs += performance.now() - began;
        const final = await source(pathname); if (!final || signature(final.stat) !== signature(before.stat)) continue;
        const existing = entries.get(pathname);
        if (existing?.signature === signature(before.stat) && existing.digest === digest) { remember(pathname, existing); return digest; }
        remember(pathname, { signature: signature(before.stat), digest, raw: null, gzip: null, gzipReady: false, bytes: 0 });
        return digest;
      }
      throw failed("STATIC_ASSET_CHANGED");
    } finally { counters.activeDigestLoads--; }
  }
  async function getDigest(pathname, timing) {
    try {
      if (!eligible(pathname)) return null;
      const before = await source(pathname); if (!before) return null;
      let cached = entries.get(pathname);
      if (cached?.signature === signature(before.stat)) { counters.hits++; timing.digestHits++; remember(pathname, cached); return cached.digest; }
      cached = null;
      let task = digestFlights.get(pathname);
      if (task) {
        timing.digestSharedFlights++; const began = performance.now();
        try { return await task; } finally { timing.digestSharedWaitMs += performance.now() - began; }
      }
      admit(pathname); const queuedAt = performance.now();
      task = digestSerial.then(async () => {
        timing.digestQueueMs += performance.now() - queuedAt; const began = performance.now();
        try { return await loadDigest(pathname, timing); } finally { timing.digestWorkMs += performance.now() - began; }
      });
      digestSerial = task.then(() => undefined, () => undefined); digestFlights.set(pathname, task);
      try { return await task; } finally { if (digestFlights.get(pathname) === task) digestFlights.delete(pathname); }
    } catch (error) { throw /^STATIC_ASSET_[A-Z_]+$/.test(error?.code || "") ? error : failed("STATIC_ASSET_UNAVAILABLE"); }
  }
  async function versionHtml(html, { onTiming = null } = {}) {
    if (onTiming !== null && typeof onTiming !== "function") throw TypeError("Invalid static HTML timing observer");
    const began = performance.now(), timing = { assetCount: 0, versionedAssetCount: 0, digestReads: 0, digestHits: 0, digestBytes: 0,
      digestQueueMs: 0, digestWorkMs: 0, digestReadMs: 0, digestHashMs: 0, digestSharedFlights: 0, digestSharedWaitMs: 0, versionHtmlMs: 0, failed: 0 };
    try {
      const pattern = /\b(src|href)=(['"])(\/[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:js|css))(?:\?[^'"<>]*)?\2/g;
      const names = [...new Set([...String(html).matchAll(pattern)].map(match => match[3]).filter(eligible))], versions = new Map();
      timing.assetCount = names.length;
      for (const name of names) { const digest = await getDigest(name, timing); if (digest) versions.set(name, digest); }
      timing.versionedAssetCount = versions.size;
      return String(html).replace(pattern, (whole, attribute, quote, name) => versions.has(name) ? attribute + "=" + quote + name + "?v=" + versions.get(name) + quote : whole);
    } catch (error) { timing.failed = 1; throw error; }
    finally {
      timing.versionHtmlMs = performance.now() - began;
      // Request-specific numbers only. Work includes read/hash substages: do
      // not add them. Shared work reports wait, never another caller's bytes.
      if (onTiming) try {
        const pending = onTiming(Object.freeze({ ...timing }));
        if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => {});
      } catch { /* Diagnostics never change responses. */ }
    }
  }
  async function response(url, { method = "GET", headers = {} } = {}) {
    if (!["GET", "HEAD"].includes(method) || !eligible(url?.pathname)) return null;
    const entry = await get(url.pathname, acceptsGzip(headers["accept-encoding"])); if (!entry) return null;
    const versioned = [...url.searchParams.keys()].length === 1 && url.searchParams.getAll("v").length === 1 && url.searchParams.get("v") === entry.digest;
    const useGzip = acceptsGzip(headers["accept-encoding"]) && Boolean(entry.gzip), body = useGzip ? entry.gzip : entry.raw, etag = 'W/"' + entry.digest + '"';
    const metadata = { "Content-Type": url.pathname.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8",
      "Cache-Control": versioned ? "private, max-age=31536000, immutable" : "private, no-cache", "ETag": etag, "Vary": "Accept-Encoding",
      ...(useGzip ? { "Content-Encoding": "gzip" } : {}) };
    if (matchesEtag(headers["if-none-match"], etag)) return { status: 304, headers: metadata, body: null };
    return { status: 200, headers: { ...metadata, "Content-Length": body.length }, body: method === "HEAD" ? null : body };
  }
  return { eligible, response, versionHtml, status: () => ({ ...counters, entries: entries.size, bytes, queuedLoads: queuedPaths(),
    maxCacheBytes, maxEntries, maxFileBytes, digestChunkBytes: DIGEST_CHUNK_BYTES }) };
}
module.exports = { createPrivateStaticAssets, eligible, acceptsGzip, matchesEtag };
