"use strict";

// Local presentation QA. Reuse the existing real-copy reader and outbound/write
// guards; add only the shared view-state asset before mounting the workspace.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const preview = require("./preview_keyword_monthly_realcopy.cjs");
const REPO = path.resolve(__dirname, "..");
const ASSETS = { ...preview.STATIC_FILES, "/admin-view-state.js": "web/admin-view-state.js" };
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink].join(":");
const fail = code => { throw Object.assign(Error(code), { code }); };
function assetBytes(relative) {
  const filename = path.join(REPO, relative), before = fs.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4 * 1024 * 1024
    || path.resolve(fs.realpathSync(filename)).toLowerCase() !== path.resolve(filename).toLowerCase()) fail("WORKSPACE_PREVIEW_UNSAFE_ASSET");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (signature(before) !== signature(fs.fstatSync(fd))) fail("WORKSPACE_PREVIEW_ASSET_CHANGED");
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== before.size || signature(before) !== signature(fs.fstatSync(fd)) || signature(before) !== signature(fs.lstatSync(filename))) fail("WORKSPACE_PREVIEW_ASSET_CHANGED");
    return bytes;
  } finally { fs.closeSync(fd); }
}
async function run(values) {
  const config = preview.args(values);
  if (config.help) { console.log(preview.USAGE.replace("preview_keyword_monthly_realcopy", "preview_keyword_monthly_workspace")); return; }
  const receiptOpen = fsp.open.bind(fsp);
  if (config.receipt) {
    const parent = await fsp.lstat(path.dirname(config.receipt));
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail("WORKSPACE_PREVIEW_RECEIPT_PARENT");
    try { await fsp.lstat(config.receipt); fail("WORKSPACE_PREVIEW_RECEIPT_EXISTS"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const before = await preview.projectionManifest(config.projectionDir), assets = new Map();
  for (const [url, relative] of Object.entries(ASSETS)) assets.set(url, { bytes: assetBytes(relative), type: url.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" });
  const referenceDay = new Date(Date.parse(before.provenance.dataThrough) + 9 * 3600000).toISOString().slice(0, 10);
  const html = preview.html(referenceDay, config.now).replace('<script defer src="/keyword-monthly-benchmark.js">', '<script defer src="/admin-view-state.js"></script><script defer src="/keyword-monthly-benchmark.js">');
  const css = ".qa-shell{width:min(1440px,100%);margin:auto;padding:28px;min-width:0}.qa-banner{border:1px solid var(--border-subtle,#dce4df);border-radius:12px;background:var(--surface-selected,#eaf1ed);padding:18px 20px;margin-bottom:24px}.qa-banner p{margin:0;color:var(--text-secondary,#5e6975);font-size:12px;line-height:1.8;overflow-wrap:anywhere}.qa-banner h1{margin:6px 0;font-size:20px;color:var(--text-primary,#172235)}.qa-theme-controls{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}.qa-theme-controls button{min-height:40px;border:1px solid var(--border-subtle,#dce4df);border-radius:8px;background:var(--surface-card,#fff);color:var(--text-primary,#172235);padding:8px 12px}body.role-admin{display:block;min-width:0;margin:0;background:var(--app-bg,#f7f8f5)}@media(max-width:640px){.qa-shell{padding:16px}.qa-banner{padding:14px}}";
  for (const [url, content, type] of [["/", html, "text/html; charset=utf-8"], ["/preview.css", css, "text/css; charset=utf-8"], ["/preview-bootstrap.js", preview.bootstrap(config.now), "text/javascript; charset=utf-8"]]) assets.set(url, { bytes: Buffer.from(content), type });
  const guards = preview.installGuards(), startedAt = new Date().toISOString(), requests = [], sockets = new Set();
  const { createKeywordMonthlyAnalysis } = require("./lib/keyword_monthly_analysis.cjs");
  const { createKeywordMonthlyHttpHandler } = require("./lib/keyword_monthly_http.cjs");
  const service = createKeywordMonthlyAnalysis({ projectionDir: config.projectionDir, now: () => new Date(config.now) });
  const localSession = Object.freeze({ role: "admin", localQaFixture: true });
  function send(res, status, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": bytes.length }); res.end(bytes);
  }
  const handle = createKeywordMonthlyHttpHandler({ service, requireAdmin: (session, req, res) => session === localSession || (send(res, 401, { code: "LOCAL_QA_ADMIN_REQUIRED" }), false), send });
  const apiPaths = new Set(["/api/keyword-monthly/options", "/api/keyword-monthly"]);
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'sha256-P/YbYQt7S4lfsxVrSSxoKSCu5BYd7bBvCOPNUdqn3GE=' 'sha256-xSRBZu31ULXl3TTPJFYLQ0R74+KEYktLd1sxwQk5y+Y=' 'sha256-r9lPDtSVHlRXoU4ci6SFdMlZxgK36NKRINLuDHqjBO0='; connect-src 'self'; img-src data:; font-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'");
    try {
      if (!["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(req.socket.remoteAddress)
        || ![`127.0.0.1:${config.port}`, `localhost:${config.port}`].includes(req.headers.host)
        || req.headers.origin && ![`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`].includes(req.headers.origin)) { send(res, 403, { code: "LOCAL_QA_LOOPBACK_REQUIRED" }); return; }
      if (typeof req.url !== "string" || !req.url.startsWith("/") || req.url.startsWith("//") || req.url.length > 4096) { send(res, 400, { code: "LOCAL_QA_PATH_INVALID" }); return; }
      const url = new URL(req.url, `http://127.0.0.1:${config.port}`);
      if (requests.length >= 1500) { send(res, 429, { code: "LOCAL_QA_TRACE_BOUND" }); return; }
      const entry = { method: req.method, path: apiPaths.has(url.pathname) || assets.has(url.pathname) ? url.pathname : "[unlisted]", startedAt: new Date().toISOString() };
      requests.push(entry); res.once("finish", () => { entry.status = res.statusCode; });
      if (req.method !== "GET") { send(res, 405, { code: "LOCAL_QA_GET_ONLY" }); return; }
      if (apiPaths.has(url.pathname)) { await handle(req, res, url, localSession); return; }
      const asset = assets.get(url.pathname);
      if (!asset || url.search) { send(res, 404, { code: "LOCAL_QA_NOT_FOUND" }); return; }
      res.writeHead(200, { "Content-Type": asset.type, "Content-Length": asset.bytes.length }); res.end(asset.bytes);
    } catch (error) { if (!res.headersSent) send(res, 503, { code: /^[A-Z][A-Z0-9_]{0,100}$/.test(error.code || "") ? error.code : "WORKSPACE_PREVIEW_READ_FAILED" }); else res.destroy(); }
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  let stopping;
  function shutdown(signal) {
    if (stopping) return stopping;
    stopping = (async () => {
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 1500); timer.unref(); });
      let after = null, verificationCode = null;
      try { after = await preview.projectionManifest(config.projectionDir); } catch (error) { verificationCode = error.code || "PROJECTION_READ_FAILED"; }
      const unchanged = Boolean(after && JSON.stringify(after.files) === JSON.stringify(before.files));
      const receipt = { schemaVersion: 1, purpose: "isolated_keyword_monthly_workspace_realcopy_qa", signal, startedAt, stoppedAt: new Date().toISOString(), fixedNow: config.now, referenceDay,
        projectionDir: config.projectionDir, projectionBefore: before, projectionAfter: after, projectionUnchanged: unchanged, verificationCode, requests,
        guards: { ...guards.counts, blockedKinds: guards.blocked }, assets: [...assets].map(([url, asset]) => ({ url, bytes: asset.bytes.length, sha256: sha(asset.bytes) })),
        applicationServerImported: false, originalSourceRead: false, productionAuthRead: false, providerCalls: 0, kosisCalls: 0, apiWrites: 0,
        authentication: "local_admin_fixture_no_account_cookie_or_credential_read", status: unchanged && guards.counts.outboundAttempts === 0 && guards.counts.blockedWriteAttempts === 0 ? "verified_local_read_only" : "needs_verification" };
      if (config.receipt) { const fd = await receiptOpen(config.receipt, "wx", 0o600); try { await fd.writeFile(JSON.stringify(receipt, null, 2) + "\n"); await fd.sync(); } finally { await fd.close(); } }
      guards.restore(); console.log(JSON.stringify({ stopped: true, status: receipt.status, projectionUnchanged: unchanged, outboundAttempts: guards.counts.outboundAttempts, receipt: config.receipt }));
      if (receipt.status !== "verified_local_read_only") process.exitCode = 1;
      return receipt;
    })();
    return stopping;
  }
  process.once("SIGINT", () => { void shutdown("SIGINT"); }); process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, "127.0.0.1", resolve); });
  console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${config.port}/`, fixedNow: config.now, referenceDay, readOnly: true, realcopy: true, localAdminFixture: true }));
  process.stdin.setEncoding("utf8"); let input = "";
  process.stdin.on("data", chunk => { input = (input + chunk).slice(-64); if (input.trim() === "quit") { process.stdin.pause(); void shutdown("stdin_quit"); } });
  return { server, shutdown };
}
if (require.main === module) run(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ code: error.code || "WORKSPACE_PREVIEW_FAILED" })); process.exitCode = 1; });
module.exports = { run };
