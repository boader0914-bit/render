"use strict";

// Local GUI QA only. This host never imports the application server, source
// catalog, collectors, provider clients, queues, authentication store or KOSIS.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const C = fs.constants;
const MAX_FILES = 4097, MAX_FILE_BYTES = 32 * 1024 * 1024, MAX_TOTAL_BYTES = 512 * 1024 * 1024, MAX_TRACE = 1500;
const REPO = path.resolve(__dirname, "..");
const STATIC_FILES = Object.freeze({
  "/styles.css": "web/styles.css",
  "/admin-theme.css": "web/admin-theme.css",
  "/monthly-reports.css": "web/monthly-reports.css",
  "/keyword-monthly-analysis.css": "web/keyword-monthly-analysis.css",
  "/keyword-monthly-analysis.js": "web/keyword-monthly-analysis.js"
});
const USAGE = "node scripts/preview_keyword_monthly_realcopy.cjs --projection-dir <absolute directory> --port 5187 --now <ISO timestamp with timezone> [--receipt <new absolute JSON file>]";
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (directory, candidate) => { const relative = path.relative(directory, candidate); return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); };
const clockValid = value => typeof value === "string" && /^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);
const code = error => /^[A-Z][A-Z0-9_]{0,110}$/.test(error?.code || error?.message || "") ? error.code || error.message : "KEYWORD_MONTHLY_PREVIEW_FAILED";
function fail(value) { throw Object.assign(new Error(value), { code: value }); }
function args(values) {
  if (values.length === 1 && values[0] === "--help") return { help: true };
  const allowed = new Set(["projection-dir", "port", "now", "receipt"]), output = {};
  for (let i = 0; i < values.length; i += 2) {
    const key = values[i]?.slice(2);
    if (!values[i]?.startsWith("--") || !allowed.has(key) || Object.hasOwn(output, key) || !values[i + 1] || values[i + 1].startsWith("--")) fail("KEYWORD_MONTHLY_PREVIEW_ARGUMENTS");
    output[key] = values[i + 1];
  }
  if (!output["projection-dir"] || !path.isAbsolute(output["projection-dir"])) fail("KEYWORD_MONTHLY_PREVIEW_ABSOLUTE_PROJECTION_REQUIRED");
  if (!clockValid(output.now)) fail("KEYWORD_MONTHLY_PREVIEW_FIXED_CLOCK_REQUIRED");
  const port = output.port === undefined ? 5187 : /^\d{4,5}$/.test(output.port) ? Number(output.port) : 0;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) fail("KEYWORD_MONTHLY_PREVIEW_PORT");
  if (output.receipt && (!path.isAbsolute(output.receipt) || path.extname(output.receipt).toLowerCase() !== ".json")) fail("KEYWORD_MONTHLY_PREVIEW_ABSOLUTE_RECEIPT_REQUIRED");
  const projectionDir = path.resolve(output["projection-dir"]), receipt = output.receipt ? path.resolve(output.receipt) : null;
  if (receipt && (inside(projectionDir, receipt) || inside(path.join(REPO, "web"), receipt) || inside(path.join(REPO, "scripts"), receipt))) fail("KEYWORD_MONTHLY_PREVIEW_RECEIPT_SCOPE");
  return { projectionDir, port, now: new Date(output.now).toISOString(), receipt };
}
async function safePath(absolute, directory) {
  const resolved = path.resolve(absolute), root = path.parse(resolved).root;
  let current = root;
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink() || !samePath(await fsp.realpath(current), current) || current !== resolved && !stat.isDirectory()) fail("KEYWORD_MONTHLY_PREVIEW_UNSAFE_PATH");
  }
  const stat = await fsp.lstat(resolved);
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) fail("KEYWORD_MONTHLY_PREVIEW_UNSAFE_PATH");
  return stat;
}
const statSame = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].every(key => a[key] === b[key]);
async function readBounded(file, maximum) {
  const before = await safePath(file, false);
  if (before.size < 1 || before.size > maximum) fail("KEYWORD_MONTHLY_PREVIEW_FILE_BOUND");
  const handle = await fsp.open(file, C.O_RDONLY | (C.O_NOFOLLOW || 0));
  try {
    if (!statSame(before, await handle.stat())) fail("KEYWORD_MONTHLY_PREVIEW_EVIDENCE_CHANGED");
    const bytes = Buffer.alloc(before.size + 1); let count = 0;
    while (count < bytes.length) { const next = await handle.read(bytes, count, bytes.length - count, count); if (!next.bytesRead) break; count += next.bytesRead; }
    if (count !== before.size || !statSame(before, await handle.stat()) || !statSame(before, await safePath(file, false))) fail("KEYWORD_MONTHLY_PREVIEW_EVIDENCE_CHANGED");
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}
async function projectionManifest(directory) {
  await safePath(directory, true);
  const top = (await fsp.readdir(directory)).sort();
  if (JSON.stringify(top) !== JSON.stringify(["index.json", "projections"])) fail("KEYWORD_MONTHLY_PREVIEW_PROJECTION_LAYOUT");
  const projections = path.join(directory, "projections"); await safePath(projections, true);
  const names = (await fsp.readdir(projections)).sort();
  if (names.length + 1 > MAX_FILES || names.some(name => !/^[a-f0-9]{64}\.json(?:\.gz)?$/.test(name))) fail("KEYWORD_MONTHLY_PREVIEW_PROJECTION_LAYOUT");
  const files = []; let totalBytes = 0, indexBytes;
  for (const name of ["index.json", ...names.map(value => `projections/${value}`)]) {
    const bytes = await readBounded(path.join(directory, ...name.split("/")), name === "index.json" ? 1024 * 1024 : MAX_FILE_BYTES);
    totalBytes += bytes.length; if (totalBytes > MAX_TOTAL_BYTES) fail("KEYWORD_MONTHLY_PREVIEW_PROJECTION_BOUND");
    files.push({ name, bytes: bytes.length, sha256: sha(bytes) }); if (name === "index.json") indexBytes = bytes;
  }
  let index; try { index = JSON.parse(indexBytes.toString("utf8")); } catch { fail("KEYWORD_MONTHLY_PREVIEW_INDEX_JSON"); }
  if (index.schemaVersion !== 1 || !clockValid(index.provenance?.dataThrough)) fail("KEYWORD_MONTHLY_PREVIEW_INDEX_PROVENANCE");
  return { files, totalBytes, manifestSha256: sha(JSON.stringify(files)), provenance: index.provenance };
}
function installGuards() {
  const counts = { outboundAttempts: 0, blockedOutboundAttempts: 0, blockedWriteAttempts: 0 }, blocked = [], restores = [];
  function patch(object, key, next) { const old = object[key]; if (typeof old !== "function") return; object[key] = next; restores.push(() => { object[key] = old; }); }
  const reject = kind => function () { counts.outboundAttempts++; counts.blockedOutboundAttempts++; if (blocked.length < 50) blocked.push(kind); fail("KEYWORD_MONTHLY_PREVIEW_OUTBOUND_BLOCKED"); };
  patch(globalThis, "fetch", reject("fetch")); patch(globalThis, "WebSocket", reject("WebSocket"));
  for (const name of ["node:http", "node:https"]) { const module = require(name); for (const key of ["request", "get"]) patch(module, key, reject(`${name}.${key}`)); }
  const net = require("node:net"); for (const key of ["connect", "createConnection"]) patch(net, key, reject(`net.${key}`)); patch(net.Socket.prototype, "connect", reject("net.Socket.connect"));
  patch(require("node:tls"), "connect", reject("tls.connect")); patch(require("node:http2"), "connect", reject("http2.connect"));
  const dgram = require("node:dgram"); for (const key of ["connect", "send"]) patch(dgram.Socket.prototype, key, reject(`dgram.${key}`));
  const dns = require("node:dns");
  // net.Server.listen resolves its explicit IP through dns.lookup. Return the
  // literal loopback locally, without invoking DNS or weakening socket guards.
  patch(dns, "lookup", function (host, settings, callback) {
    if (host !== "127.0.0.1") return reject("dns.lookup")();
    const done = typeof settings === "function" ? settings : callback;
    process.nextTick(() => settings?.all ? done(null, [{ address: host, family: 4 }]) : done(null, host, 4));
  });
  if (dns.promises) patch(dns.promises, "lookup", async function (host, settings) {
    if (host !== "127.0.0.1") return reject("dns.promises.lookup")();
    return settings?.all ? [{ address: host, family: 4 }] : { address: host, family: 4 };
  });
  for (const key of ["lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]) { patch(dns, key, reject(`dns.${key}`)); if (dns.promises) patch(dns.promises, key, reject(`dns.promises.${key}`)); }
  const child = require("node:child_process"); for (const key of ["exec", "execFile", "spawn", "fork", "execSync", "execFileSync", "spawnSync"]) patch(child, key, reject(`child_process.${key}`));
  function rejectWrite() { counts.blockedWriteAttempts++; fail("KEYWORD_MONTHLY_PREVIEW_WRITE_BLOCKED"); }
  for (const object of [fs, fsp]) for (const key of ["writeFile", "appendFile", "mkdir", "mkdtemp", "rename", "copyFile", "cp", "rm", "rmdir", "unlink", "truncate", "chmod", "chown", "utimes", "link", "symlink"]) { patch(object, key, rejectWrite); patch(object, `${key}Sync`, rejectWrite); }
  const isWrite = flags => typeof flags === "number" ? Boolean(flags & (C.O_WRONLY | C.O_RDWR | C.O_APPEND | C.O_CREAT | C.O_TRUNC)) : flags !== "r" && flags !== "rs";
  for (const object of [fs, fsp]) for (const key of ["open", "openSync"]) { const original = object[key]; if (typeof original === "function") patch(object, key, function (file, flags, ...rest) { if (isWrite(flags)) return rejectWrite(); return original.call(this, file, flags, ...rest); }); }
  patch(fs, "createWriteStream", rejectWrite);
  return { counts, blocked, restore() { for (const restore of restores.reverse()) restore(); } };
}
function html(referenceDay, fixedNow) {
  const label = referenceDay.slice(5).replace("-", "/");
  return `<!doctype html><html lang="ko" data-theme-resolved="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>키워드 월별 분석 · 실자료 사본 검증</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/admin-theme.css"><link rel="stylesheet" href="/monthly-reports.css"><link rel="stylesheet" href="/keyword-monthly-analysis.css"><link rel="stylesheet" href="/preview.css"><script defer src="/keyword-monthly-analysis.js"></script><script defer src="/preview-bootstrap.js"></script></head><body class="role-admin"><main class="qa-shell"><header class="qa-banner"><p>운영과 분리된 실자료 사본 검증 · 시점 ${label}</p><h1>키워드 월별 누적 분석</h1><p>로컬 관리자 세션 · 고정 검증 시각 ${fixedNow} · 저장된 사본 조회만 수행</p></header><div id="keywordMonthlyDashboard"></div></main></body></html>`;
}
const PREVIEW_CSS = ".qa-shell{width:min(1400px,100%);margin:0 auto;padding:28px;min-width:0}.qa-banner{border:1px solid var(--border-strong,#afc2b5);border-radius:12px;background:var(--surface-selected,#eaf1ed);padding:18px 20px;margin-bottom:24px}.qa-banner p{margin:0;color:var(--text-secondary,#5e6975);font-size:12px;line-height:1.8}.qa-banner h1{margin:6px 0;font-size:20px;color:var(--text-primary,#172235)}body.role-admin{display:block;min-width:0;margin:0;background:var(--app-bg,#f7f8f5)}@media(max-width:640px){.qa-shell{padding:16px}.qa-banner{padding:14px}.qa-banner p{overflow-wrap:anywhere}}";
function bootstrap(now) {
  return `"use strict";(() => { const parent=document.getElementById("keywordMonthlyDashboard"); window.KeywordMonthlyAnalysis.mount(parent,{autoStart:false,now:()=>Date.parse(${JSON.stringify(now)})}); window.KeywordMonthlyAnalysis.show(parent); window.addEventListener("pagehide",()=>window.KeywordMonthlyAnalysis.pause(parent)); })();`;
}
function safeQuery(url) {
  const output = {}; for (const key of ["keyword", "month", "cutoffDate"]) { const values = url.searchParams.getAll(key); if (values.length === 1) output[key] = values[0].slice(0, key === "keyword" ? 300 : 20); }
  if ([...url.searchParams.keys()].some(key => !["keyword", "month", "cutoffDate"].includes(key))) output.unlistedParameter = true;
  return output;
}
async function run(input) {
  const config = args(input);
  if (config.help) { console.log(USAGE); return null; }
  // Capture this single receipt-only writer before read-only guards are active.
  const receiptOpen = fsp.open.bind(fsp);
  if (config.receipt) { await safePath(path.dirname(config.receipt), true); try { await fsp.lstat(config.receipt); fail("KEYWORD_MONTHLY_PREVIEW_RECEIPT_EXISTS"); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  const before = await projectionManifest(config.projectionDir), staticAssets = new Map();
  for (const [url, relative] of Object.entries(STATIC_FILES)) { const bytes = await readBounded(path.join(REPO, relative), 4 * 1024 * 1024); staticAssets.set(url, { bytes, type: url.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" }); }
  const referenceDay = new Date(Date.parse(before.provenance.dataThrough) + 9 * 3600000).toISOString().slice(0, 10);
  staticAssets.set("/", { bytes: Buffer.from(html(referenceDay, config.now)), type: "text/html; charset=utf-8" });
  staticAssets.set("/preview.css", { bytes: Buffer.from(PREVIEW_CSS), type: "text/css; charset=utf-8" });
  staticAssets.set("/preview-bootstrap.js", { bytes: Buffer.from(bootstrap(config.now)), type: "text/javascript; charset=utf-8" });
  const guard = installGuards(), actualStartedAt = new Date().toISOString(), trace = [], sockets = new Set(); let traceOverflow = 0, closing = false, shutdownPromise;
  const { createKeywordMonthlyAnalysis } = require("./lib/keyword_monthly_analysis.cjs");
  const { createKeywordMonthlyHttpHandler } = require("./lib/keyword_monthly_http.cjs");
  const service = createKeywordMonthlyAnalysis({ projectionDir: config.projectionDir, now: () => new Date(config.now) });
  const localSession = Object.freeze({ role: "admin", localQaFixture: true });
  function security(res) {
    res.setHeader("Cache-Control", "private, no-store"); res.setHeader("Pragma", "no-cache"); res.setHeader("Vary", "Cookie");
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  }
  function send(res, status, value) { const bytes = Buffer.from(JSON.stringify(value)); res.qaOutcome = { status: value.status || null, diagnostics: Array.isArray(value.diagnostics) ? value.diagnostics.filter(item => typeof item === "string").slice(0, 30) : [], responseSha256: sha(bytes), responseBytes: bytes.length }; res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": bytes.length }); res.end(bytes); }
  const handler = createKeywordMonthlyHttpHandler({ service, requireAdmin: (session, req, res) => { if (session === localSession) return true; send(res, 401, { error: "LOCAL_QA_ADMIN_REQUIRED" }); return false; }, send });
  const apiPaths = new Set(["/api/keyword-monthly/options", "/api/keyword-monthly"]);
  const server = http.createServer(async (req, res) => {
    security(res); let url, entry;
    try {
      const host = req.headers.host;
      if (!["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(req.socket.remoteAddress) || ![`127.0.0.1:${config.port}`, `localhost:${config.port}`].includes(host)
        || req.headers.origin && ![`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`].includes(req.headers.origin)) { send(res, 403, { code: "LOCAL_QA_LOOPBACK_REQUIRED" }); return; }
      if (closing) { send(res, 503, { code: "LOCAL_QA_CLOSING" }); return; }
      if (typeof req.url !== "string" || !req.url.startsWith("/") || req.url.startsWith("//") || req.url.length > 4096) { send(res, 400, { code: "LOCAL_QA_PATH_INVALID" }); return; }
      url = new URL(req.url, `http://127.0.0.1:${config.port}`);
      const known = apiPaths.has(url.pathname) || staticAssets.has(url.pathname);
      entry = { sequence: trace.length + traceOverflow + 1, method: req.method, path: known ? url.pathname : "[unlisted]", query: apiPaths.has(url.pathname) ? safeQuery(url) : {}, startedAt: new Date().toISOString(), fixedNow: config.now };
      if (trace.length < MAX_TRACE) trace.push(entry); else { traceOverflow++; send(res, 429, { code: "LOCAL_QA_TRACE_BOUND" }); return; }
      res.once("finish", () => { entry.statusCode = res.statusCode; entry.finishedAt = new Date().toISOString(); if (res.qaOutcome) Object.assign(entry, res.qaOutcome); });
      if (req.method !== "GET") { send(res, 405, { code: "LOCAL_QA_GET_ONLY" }); return; }
      if (apiPaths.has(url.pathname)) { await handler(req, res, url, localSession); return; }
      if (url.search || !staticAssets.has(url.pathname)) { send(res, 404, { code: "LOCAL_QA_NOT_FOUND" }); return; }
      const asset = staticAssets.get(url.pathname); res.writeHead(200, { "Content-Type": asset.type, "Content-Length": asset.bytes.length }); res.end(asset.bytes);
    } catch (error) { if (!res.headersSent) send(res, 503, { code: code(error) }); else res.destroy(); if (entry) entry.failureCode = code(error); }
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("clientError", (error, socket) => { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });
  async function shutdown(signal) {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    shutdownPromise = (async () => {
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 1500); timer.unref(); });
      let after = null, verificationCode = null;
      try { after = await projectionManifest(config.projectionDir); } catch (error) { verificationCode = code(error); }
      const unchanged = Boolean(after && before.manifestSha256 === after.manifestSha256 && JSON.stringify(before.files) === JSON.stringify(after.files));
      const receipt = { schemaVersion: 1, purpose: "isolated_keyword_monthly_realcopy_gui_qa", signal, actualStartedAt, actualStoppedAt: new Date().toISOString(), fixedNow: config.now,
        listener: { address: "127.0.0.1", port: config.port, allowedHosts: [`127.0.0.1:${config.port}`, `localhost:${config.port}`] }, authentication: "local_admin_fixture_no_account_cookie_or_credential_read",
        referenceDay, projectionDir: config.projectionDir, projectionBefore: { files: before.files, totalBytes: before.totalBytes, manifestSha256: before.manifestSha256 }, projectionAfter: after ? { files: after.files, totalBytes: after.totalBytes, manifestSha256: after.manifestSha256 } : null,
        projectionUnchanged: unchanged, verificationCode, requests: trace, traceOverflow, apiGetCount: trace.filter(row => apiPaths.has(row.path) && row.method === "GET").length,
        guards: { ...guard.counts, blockedKinds: guard.blocked }, providerCalls: 0, kosisCalls: 0, collectorStarted: false, applicationServerImported: false, productionAuthRead: false, originalSourceRead: false,
        apiWrites: 0, browserOutboundPolicy: "CSP self-only API/script/style; external fonts/images/media/workers/frames disallowed", receiptWrite: config.receipt ? "one exclusive wx file on shutdown only" : "not requested",
        assets: [...staticAssets].map(([url, asset]) => ({ url, bytes: asset.bytes.length, sha256: sha(asset.bytes) })),
        status: unchanged && guard.counts.outboundAttempts === 0 && guard.counts.blockedWriteAttempts === 0 && traceOverflow === 0 ? "verified_local_read_only" : "needs_verification" };
      if (config.receipt) {
        await safePath(path.dirname(config.receipt), true);
        const handle = await receiptOpen(config.receipt, "wx", 0o600);
        try { await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
      }
      guard.restore();
      console.log(JSON.stringify({ stopped: true, status: receipt.status, projectionUnchanged: unchanged, outboundAttempts: guard.counts.outboundAttempts, apiGetCount: receipt.apiGetCount, receipt: config.receipt }));
      if (receipt.status !== "verified_local_read_only") process.exitCode = 1;
      return receipt;
    })();
    return shutdownPromise;
  }
  const onSignal = signal => { void shutdown(signal).catch(error => { console.error(JSON.stringify({ code: code(error), receiptWritten: false })); process.exitCode = 1; guard.restore(); }); };
  const onInt = () => onSignal("SIGINT"), onTerm = () => onSignal("SIGTERM");
  process.once("SIGINT", onInt); process.once("SIGTERM", onTerm);
  try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, "127.0.0.1", resolve); }); }
  catch (error) { process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm); guard.restore(); throw error; }
  console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${config.port}/`, fixedNow: config.now, referenceDay, localAdminFixture: true, readOnly: true, receiptOnShutdown: config.receipt }));
  return { shutdown, server };
}
if (require.main === module) run(process.argv.slice(2)).then(runtime => {
  if (!runtime) return;
  // Windows process supervision may terminate without delivering SIGINT. An
  // explicit local stdin command permits a verified, orderly evidence receipt.
  process.stdin.setEncoding("utf8");
  let pending = "";
  const input = chunk => {
    pending += chunk;
    if (pending.length > 64) pending = pending.slice(-64);
    if (!pending.includes("\n") || pending.trim() !== "quit") return;
    process.stdin.removeListener("data", input); process.stdin.pause();
    void runtime.shutdown("stdin_quit").catch(error => { console.error(JSON.stringify({ code: code(error) })); process.exitCode = 1; });
  };
  process.stdin.on("data", input);
}).catch(error => { console.error(JSON.stringify({ code: code(error) })); process.exitCode = 1; });
module.exports = { args, run, html, bootstrap, installGuards, projectionManifest, STATIC_FILES, USAGE };
