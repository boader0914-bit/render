"use strict";

// Local static UI fixture preview; never starts the application or a scheduler.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { createFixture, browserBootstrap } = require("./fixtures/collection_workspace_preview.cjs");
const root = path.resolve(__dirname, "..", "web");
const styles = ["styles.css", "admin-theme.css", "collector-controls.css", "collection_rotation_controls.css", "collection-monitor.css", "collection-workspace.css"];
const scripts = ["collector_controls.js", "collection_rotation_controls.js", "collection-monitor.js", "collection-workspace.js"];
const allowedAssets = new Set([...styles, ...scripts]);

function extractSurface(html) {
  const start = html.indexOf('<section class="collector-controls-card');
  if (start < 0 || !html.slice(start, start + 240).includes('id="collectorControlsCard"')) throw new Error("PREVIEW_SURFACE_NOT_FOUND");
  const tags = /<\/?section\b[^>]*>/gi; tags.lastIndex = start;
  let depth = 0, match;
  while ((match = tags.exec(html))) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, tags.lastIndex);
  }
  throw new Error("PREVIEW_SURFACE_UNBALANCED");
}
function buildHtml() {
  const surface = extractSurface(fs.readFileSync(path.join(root, "index.html"), "utf8"));
  const fixture = JSON.stringify(createFixture()).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="ko" data-theme-resolved="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>수집 운영 UI · 개발 검증용</title>${styles.map(file => `<link rel="stylesheet" href="/${file}">`).join("")}
<style>body.role-admin{margin:0;background:var(--app-bg,#f7f8f5)}.workspace-preview-shell{max-width:1480px;margin:0 auto;padding:28px 32px 80px}.workspace-preview-notice{display:flex;flex-wrap:wrap;gap:8px 24px;align-items:center;justify-content:space-between;padding:12px 16px;margin:0 0 28px;border:1px solid #d5b86d;border-radius:10px;background:#fff8e5;color:#765218;font:12px/1.7 system-ui}.workspace-preview-notice strong{font-weight:750}.workspace-preview-notice p{margin:0}.workspace-preview-section{display:block!important} @media(max-width:600px){.workspace-preview-shell{padding:12px 12px 48px}.workspace-preview-notice{margin-bottom:20px}}</style></head><body class="role-admin"><main class="workspace-preview-shell"><aside class="workspace-preview-notice"><strong>개발 검증용 모의자료 · 운영 화면 아님</strong><p id="workspacePreviewStatus" role="status">실행·저장·외부 호출 차단 · 화면과 조건 보존 검증용</p></aside><section class="admin-section-panel active workspace-preview-section" data-admin-section-panel="collect">${surface}</section></main><script>(${browserBootstrap.toString()})(${fixture});</script>${scripts.map(file => `<script src="/${file}"></script>`).join("")}</body></html>`;
}
function createServer() {
  return http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'");
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end("PREVIEW_READ_ONLY"); }
    let url;
    try { url = new URL(req.url, "http://127.0.0.1"); } catch { res.writeHead(400); return res.end(); }
    if (url.pathname === "/" || url.pathname === "/collection-workspace-preview/") {
      const html = buildHtml(); res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(req.method === "HEAD" ? undefined : html);
    }
    const file = url.pathname.slice(1);
    if (!allowedAssets.has(file)) { res.writeHead(404); return res.end("PREVIEW_ASSET_NOT_ALLOWED"); }
    const content = fs.readFileSync(path.join(root, file));
    res.writeHead(200, { "Content-Type": file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : content);
  });
}
if (require.main === module) {
  const argument = process.argv.slice(2);
  if (argument.length && !(argument.length === 2 && argument[0] === "--port" && /^\d{1,5}$/.test(argument[1]) && Number(argument[1]) < 65536)) throw new Error("Usage: node scripts/preview_collection_workspace.cjs [--port 0]");
  const server = createServer();
  server.listen(Number(argument[1] || 0), "127.0.0.1", () => console.log(`PREVIEW_URL=http://127.0.0.1:${server.address().port}/collection-workspace-preview/`));
}
module.exports = { createServer, buildHtml, extractSurface, allowedAssets };
