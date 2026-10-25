"use strict";

// Static code/styles only. The caller owns authentication and must invoke this
// after its existing guard. HTML, API data, outputs and service workers stay out.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), zlib = require("node:zlib");
const { promisify } = require("node:util");
const gzip = promisify(zlib.gzip);
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
  const root = path.resolve(directory), entries = new Map(), flights = new Map(); let bytes = 0, serial = Promise.resolve();
  const counters = { reads: 0, hits: 0, gzipBuilds: 0, evictions: 0, activeLoads: 0, maximumActiveLoads: 0 };
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
  async function load(pathname) {
    counters.activeLoads++; counters.maximumActiveLoads = Math.max(counters.maximumActiveLoads, counters.activeLoads);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = await source(pathname); if (!before) return null;
        const cached = entries.get(pathname);
        if (cached?.signature === signature(before.stat)) { counters.hits++; remember(pathname, cached); return cached; }
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
        const digest = crypto.createHash("sha256").update(raw).digest("hex"); let compressed = null;
        try { counters.gzipBuilds++; const encoded = await gzipImpl(raw, { level: 4 }); if (Buffer.isBuffer(encoded) && encoded.length < raw.length) compressed = encoded; } catch { /* Identity is still the exact verified static resource. */ }
        const final = await source(pathname); if (!final || signature(final.stat) !== signature(before.stat)) continue;
        const entry = { signature: signature(before.stat), digest, raw, gzip: compressed, bytes: raw.length + (compressed?.length || 0) };
        remember(pathname, entry); return entry;
      }
      throw failed("STATIC_ASSET_CHANGED");
    } finally { counters.activeLoads--; }
  }
  async function getOwned(pathname) {
    if (!eligible(pathname)) return null;
    const before = await source(pathname); if (!before) return null;
    const cached = entries.get(pathname);
    if (cached?.signature === signature(before.stat)) { counters.hits++; remember(pathname, cached); return cached; }
    if (flights.has(pathname)) return flights.get(pathname);
    if (flights.size >= maxEntries) throw failed("STATIC_ASSET_BUSY");
    // Only paths await admission. Read/compress one bounded file at a time,
    // avoiding queues retaining many raw or in-progress gzip buffers.
    const task = serial.then(() => load(pathname)); serial = task.then(() => undefined, () => undefined); flights.set(pathname, task);
    try { return await task; } finally { if (flights.get(pathname) === task) flights.delete(pathname); }
  }
  async function get(pathname) {
    try { return await getOwned(pathname); }
    catch (error) { throw /^STATIC_ASSET_[A-Z_]+$/.test(error?.code || "") ? error : failed("STATIC_ASSET_UNAVAILABLE"); }
  }
  async function versionHtml(html) {
    const pattern = /\b(src|href)=(['"])(\/[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:js|css))(?:\?[^'"<>]*)?\2/g;
    const names = [...new Set([...String(html).matchAll(pattern)].map(match => match[3]).filter(eligible))], versions = new Map();
    for (const name of names) { const entry = await get(name); if (entry) versions.set(name, entry.digest); }
    return String(html).replace(pattern, (whole, attribute, quote, name) => versions.has(name) ? `${attribute}=${quote}${name}?v=${versions.get(name)}${quote}` : whole);
  }
  async function response(url, { method = "GET", headers = {} } = {}) {
    if (!["GET", "HEAD"].includes(method) || !eligible(url?.pathname)) return null;
    const entry = await get(url.pathname); if (!entry) return null;
    const versioned = [...url.searchParams.keys()].length === 1 && url.searchParams.getAll("v").length === 1 && url.searchParams.get("v") === entry.digest;
    const useGzip = acceptsGzip(headers["accept-encoding"]) && Boolean(entry.gzip), body = useGzip ? entry.gzip : entry.raw, etag = `W/"${entry.digest}"`;
    const metadata = { "Content-Type": url.pathname.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8",
      "Cache-Control": versioned ? "private, max-age=31536000, immutable" : "private, no-cache", "ETag": etag, "Vary": "Accept-Encoding",
      ...(useGzip ? { "Content-Encoding": "gzip" } : {}) };
    if (matchesEtag(headers["if-none-match"], etag)) return { status: 304, headers: metadata, body: null };
    return { status: 200, headers: { ...metadata, "Content-Length": body.length }, body: method === "HEAD" ? null : body };
  }
  return { eligible, response, versionHtml, status: () => ({ ...counters, entries: entries.size, bytes, queuedLoads: flights.size, maxCacheBytes, maxEntries, maxFileBytes }) };
}
module.exports = { createPrivateStaticAssets, eligible, acceptsGzip, matchesEtag };
